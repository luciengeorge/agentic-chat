import { sql } from "drizzle-orm";

/**
 * The app's observability hooks (section 19), built from `#learn/observability/*`. Everything here is off unless
 * configured (`#learn/observability/config`): with no collector and no conversation log, each function hands back
 * exactly what it was given, or nothing, and the app runs as it did.
 *
 * - `OTEL_EXPORTER_OTLP_ENDPOINT` set: spans and metrics for chat turns, retrieval, model calls, agent steps and
 *   tool calls, and a cost per request.
 * - `CONVERSATION_LOG_FILE` set: each finished chat turn goes to that file as a JSON line, through the outbox.
 * Server only.
 */
import type { AgentTool } from "#learn/agent/types";
import type { Retrieve, Viewer } from "#learn/retrieve/types";
import type { Tx } from "@/db/tenant";
import type { RunnerLoop } from "@/lib/agent-runs";

import { conversationLogFile, telemetryConfig } from "#learn/observability/config";
import {
  conversationLogExporter,
  enqueueConversationLog,
  type Exporter,
  fileSink,
} from "#learn/observability/conversation-log";
import { recordDenial } from "#learn/observability/metrics";
import { observeRequest } from "#learn/observability/request";
import { startTelemetry, type Telemetry } from "#learn/observability/setup";
import { agentStep, tracedRetrieve, tracedTools } from "#learn/observability/spans";
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

/**
 * The chat route's observer, or undefined when telemetry and the conversation log are both off. The exporter is
 * the process's own unless given (tests pass one on their database).
 */
export function chatObserver(
  env: Env = process.env,
  telemetry: Telemetry | null = appTelemetry(env),
  exporter: Exporter | null = conversationLogFile(env) ? exporterFor(conversationLogFile(env)!) : null,
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
    committed: () => exporter?.kick(),
  };
}
