import { sql } from "drizzle-orm";

/**
 * The app's observability hooks (section 19), built from `#learn/observability/*`. Everything here is off unless
 * configured (`#learn/observability/config`): with no collector and no conversation log, each function hands back
 * exactly what it was given, or nothing, and the app runs as it did.
 *
 * - `OTEL_EXPORTER_OTLP_ENDPOINT` set: spans and metrics for chat turns, retrieval, model calls, agent steps and
 *   tool calls, and a cost per request.
 * - `CONVERSATION_LOG_FILE` set: each finished chat turn goes to that file as a JSON line, through the outbox and
 *   its relay.
 * Server only.
 */
import type { AgentTool } from "#learn/agent/types";
import type { Retrieve, Viewer } from "#learn/retrieve/types";
import type { Db } from "@/db/create";
import type { Tx } from "@/db/tenant";
import type { RunnerLoop } from "@/lib/agent-runs";

import { conversationLogFile, telemetryConfig } from "#learn/observability/config";
import {
  conversationLogExporter,
  enqueueConversationLog,
  type ExportOptions,
  exportConversationLog,
  type Exporter,
  fileSink,
  type Sink,
} from "#learn/observability/conversation-log";
import { recordDenial } from "#learn/observability/metrics";
import { observeRequest } from "#learn/observability/request";
import { startTelemetry, type Telemetry } from "#learn/observability/setup";
import { agentStep, tracedRetrieve, tracedTools } from "#learn/observability/spans";
import { kickRelay } from "@/db/outbox";
import { systemDb } from "@/db/pool";
import { withTenant } from "@/db/tenant";
import { createLogger } from "@/lib/logger";

type Env = Record<string, string | undefined>;

const logger = createLogger("observability");

/** Telemetry for this process, started on first use when a collector is configured; null when it isn't. */
export function appTelemetry(env: Env = process.env): Telemetry | null {
  return startTelemetry(telemetryConfig(env));
}

/** The chunks the ACL withheld from one retrieval, as its audit row recorded them. */
async function deniedCount(viewer: Viewer, auditId: string): Promise<number> {
  const [row] = await withTenant(viewer.tenantId, (tx) =>
    tx.execute<{ n: number }>(sql`SELECT cardinality(denied_ids) AS n FROM retrieval_audit WHERE id = ${auditId}`),
  );
  return Number(row?.n ?? 0);
}

/** `retrieve` with a span and the ACL denial count, or `retrieve` itself when telemetry is off. */
export function observedRetrieve(retrieve: Retrieve, telemetry: Telemetry | null = appTelemetry()): Retrieve {
  if (!telemetry) return retrieve;
  return tracedRetrieve(telemetry.tracer, retrieve, {
    async onResult(retrieval, span, viewer) {
      const denied = await deniedCount(viewer, retrieval.auditId);
      span.setAttribute("agentic_chat.retrieval.denied", denied);
      recordDenial(telemetry.metrics, "acl", denied);
    },
  });
}

/** The agent's tools with a span per call, or the same tools when telemetry is off. */
export function observedTools(tools: AgentTool[], telemetry: Telemetry | null = appTelemetry()): AgentTool[] {
  return telemetry ? tracedTools(telemetry.tracer, tools) : tools;
}

/** The runner's loop with a span, latency and cost per step, or the same loop when telemetry is off. */
export function observedLoop(loop: RunnerLoop, telemetry: Telemetry | null = appTelemetry()): RunnerLoop {
  if (!telemetry) return loop;
  const runOf = (run: { id: string; kind: string; conversationId?: string | null }) => ({
    runId: run.id,
    kind: run.kind,
    conversationId: run.conversationId,
  });
  return {
    ...loop,
    modelTurn: (context, ctx) =>
      agentStep(telemetry.tracer, "model", runOf(ctx.run), () =>
        observeRequest(telemetry, { route: "agent_step" }, () => loop.modelTurn(context, ctx)),
      ),
    runTools: (calls, ctx) =>
      agentStep(telemetry.tracer, "tools", runOf(ctx.run), async () => {
        recordDenial(telemetry.metrics, "policy", calls.filter((call) => "denied" in call && call.denied).length);
        return loop.runTools(calls, ctx);
      }),
  };
}

/** What the chat route tells observability about a turn (`ChatDeps.observe`). */
export interface ChatObserver {
  /** Wraps one turn's work: retrieval, the answer and saving it. `fn` returns the reply's status. */
  turn(conversationId: string, fn: () => Promise<"complete" | "aborted">): Promise<"complete" | "aborted">;
  rateLimited(): void;
  /** Inside the reply's transaction, once it's saved. */
  saved(tx: Tx, reply: { tenantId: string; conversationId: string; replyId: string }): Promise<void>;
  /** After that transaction committed. */
  committed(): void;
}

const EXPORTER = Symbol.for("agentic-chat.conversation-log-exporter");

/** One exporter per process: the dev server loads modules more than once. */
function exporterFor(file: string): Exporter {
  const store = globalThis as typeof globalThis & { [EXPORTER]?: Exporter };
  return (store[EXPORTER] ??= conversationLogExporter(systemDb(), fileSink(file), {
    onError: (error) => logger.error("conversation log export failed", { error }),
  }));
}

/** This process's conversation log exporter, or null when the log is off. The relay hands it each log row. */
export function processConversationLog(env: Env = process.env): Exporter | null {
  const file = conversationLogFile(env);
  return file ? exporterFor(file) : null;
}

export const LOG_PASS_BATCHES = 5;

export interface LogPassResult {
  batches: number;
  exported: number;
  gone: number;
  /** The sink's error, when it failed: the pass stops there, and each row in that batch has one more attempt. */
  error: string | null;
}

/**
 * One bounded drain of the conversation log, run by every relay pass (the dev relay's poll and the cron route).
 * The exporter only drains when the relay hands it a row, so a row the relay published while the sink was down
 * would wait for the next chat. Here it goes out on the next pass: every unclaimed, unfailed log row, published or
 * not, at most `maxBatches` batches, stopping at the first sink error. Each failure counts an attempt, so after
 * `maxAttempts` a row is failed and left alone.
 */
export async function conversationLogPass(
  db: Db,
  sink: Sink,
  { maxBatches = LOG_PASS_BATCHES, ...options }: ExportOptions & { maxBatches?: number } = {},
): Promise<LogPassResult> {
  const batchSize = options.batchSize ?? 50;
  const result: LogPassResult = { batches: 0, exported: 0, gone: 0, error: null };
  while (result.batches < maxBatches) {
    result.batches += 1;
    const batch = await exportConversationLog(db, sink, { ...options, batchSize });
    result.exported += batch.exported;
    result.gone += batch.gone;
    if (batch.error) return { ...result, error: batch.error };
    if (batch.exported + batch.gone < batchSize) break;
  }
  return result;
}

/** This process's log pass, on the owner's pool and the configured file, or null when the log is off. */
export function processConversationLogPass(env: Env = process.env): (() => Promise<LogPassResult>) | null {
  const file = conversationLogFile(env);
  return file ? () => conversationLogPass(systemDb(), fileSink(file)) : null;
}

/**
 * The chat route's observer, or undefined when telemetry and the conversation log are both off. The exporter is
 * the process's own unless given (tests pass one on their database); it only says whether the log is on here,
 * since the relay is what hands it the rows.
 */
export function chatObserver(
  env: Env = process.env,
  telemetry: Telemetry | null = appTelemetry(env),
  exporter: Exporter | null = processConversationLog(env),
): ChatObserver | undefined {
  if (!telemetry && !exporter) return undefined;
  return {
    turn: (conversationId, fn) =>
      telemetry
        ? observeRequest(
            telemetry,
            {
              route: "chat_turn",
              attributes: { "gen_ai.conversation.id": conversationId },
              statusOf: (status) => (status === "complete" ? "ok" : status),
            },
            fn,
          )
        : fn(),
    rateLimited: () => {
      if (telemetry) recordDenial(telemetry.metrics, "rate_limit");
    },
    saved: async (tx, reply) => {
      if (exporter) {
        await enqueueConversationLog(tx, reply.tenantId, {
          conversationId: reply.conversationId,
          replyId: reply.replyId,
        });
      }
    },
    // The relay delivers the log row as it delivers any outbox row; kicked now, it needn't wait for its poll.
    committed: () => {
      if (exporter) kickRelay();
    },
  };
}
