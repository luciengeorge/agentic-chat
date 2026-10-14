import { and, eq, sql } from "drizzle-orm";

import type { AgentContext } from "#learn/agent/context";
import type { AgentTool, NextAction, RunEvent, RunEventData, RunStatus, ToolCall } from "#learn/agent/types";
import type { ChatModel, ReasoningEffort } from "#learn/model/types";
import type { Viewer } from "#learn/retrieve/types";
import type { Db } from "@/db/create";

import { type Caps, DEFAULT_CAPS } from "#learn/agent/caps";
import { compact, type CompactionSettings } from "#learn/agent/compact";
import { buildContext, DEFAULT_CONTEXT_TOKENS } from "#learn/agent/context";
import { append, readEvents, VersionConflictError } from "#learn/agent/events";
import { approvalNeeded, decide, modelTurn, type RunGuard, runTools } from "#learn/agent/loop";
import { listNotes } from "#learn/agent/memory";
import { isFinal } from "#learn/agent/state";
import { approvals, runs } from "@/db/schema";
import { type Tx, withTenantOn } from "@/db/tenant";
import { createLogger } from "@/lib/logger";

export { append, readEvents, VersionConflictError } from "#learn/agent/events";
export { IllegalTransitionError } from "#learn/agent/state";

const logger = createLogger("agent.runs");

export type RunKind = "chat" | "automation" | "subagent";

export interface RunRow {
  id: string;
  userId: string;
  conversationId: string | null;
  parentRunId: string | null;
  kind: RunKind;
  status: RunStatus;
  version: number;
  caps: Record<string, unknown>;
  activeMs: number;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface RunState {
  run: RunRow;
  events: RunEvent[];
}

/** Seven days, as section 15's approval hooks. */
export const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_CONFLICT_RETRIES = 20;

function pgCode(error: unknown): string | undefined {
  for (let e = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

const inTenant = <T>(db: Db, viewer: Viewer, fn: (tx: Tx) => Promise<T>) => withTenantOn(db, viewer.tenantId, fn);

/** The run, if it's the viewer's. Another user's run and another tenant's (which RLS hides) both give null. */
export async function loadRun(tx: Tx, viewer: Viewer, runId: string): Promise<RunRow | null> {
  const [row] = await tx.select().from(runs).where(eq(runs.id, runId));
  if (!row || row.userId !== viewer.userId) return null;
  return {
    id: row.id,
    userId: row.userId,
    conversationId: row.conversationId,
    parentRunId: row.parentRunId,
    kind: row.kind as RunKind,
    status: row.status as RunStatus,
    version: row.version,
    caps: row.caps as Record<string, unknown>,
    activeMs: row.activeMs,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

export async function loadState(tx: Tx, viewer: Viewer, runId: string): Promise<RunState | null> {
  const run = await loadRun(tx, viewer, runId);
  if (!run) return null;
  const events: RunEvent[] = [];
  for (let page = await readEvents(tx, runId); page.length > 0; page = await readEvents(tx, runId, page.at(-1)!.seq)) {
    events.push(...page);
  }
  return { run, events };
}

export interface NewMessage {
  /** The client's id for the message: its idempotency key. */
  messageId: string;
  text: string;
}

export type MessageResult =
  | { kind: "not-found" }
  | { kind: "finished"; status: RunStatus }
  | { kind: "added" | "duplicate"; seq: number; status: RunStatus };

/** Appends `events`, re-reading and trying again while other writers get in first. For events that stay true
 * whatever was appended meanwhile (a user message, a tool result). */
async function appendRetrying(
  tx: Tx,
  runId: string,
  build: (state: { version: number; status: RunStatus }) => RunEventData[] | null,
  activeMs = 0,
) {
  for (let attempt = 0; ; attempt++) {
    const [run] = await tx.execute<{ status: RunStatus; version: number }>(
      sql`SELECT status, version FROM runs WHERE id = ${runId}`,
    );
    const events = build(run);
    if (!events) return null;
    try {
      return await append(tx, runId, run.version, events, { activeMs });
    } catch (error) {
      if (!(error instanceof VersionConflictError) || attempt >= MAX_CONFLICT_RETRIES) throw error;
    }
  }
}

async function messageSeq(tx: Tx, runId: string, messageId: string): Promise<number | null> {
  const [row] = await tx.execute<{ seq: number }>(sql`
    SELECT seq FROM run_events
    WHERE run_id = ${runId} AND type = 'user_message' AND data ->> 'messageId' = ${messageId}`);
  return row ? Number(row.seq) : null;
}

/**
 * Adds a user message to a live run, once per `messageId`: a resend finds the first one and stores nothing.
 * Messages that arrive together all land, in `seq` order: a writer that loses the version race reads again and
 * appends after the winner. A message can't go into a finished run.
 */
export async function addMessage(db: Db, viewer: Viewer, runId: string, message: NewMessage): Promise<MessageResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await inTenant(db, viewer, async (tx) => {
        const run = await loadRun(tx, viewer, runId);
        if (!run) return { kind: "not-found" } as const;
        const seen = await messageSeq(tx, runId, message.messageId);
        if (seen !== null) return { kind: "duplicate", seq: seen, status: run.status } as const;
        const appended = await appendRetrying(tx, runId, ({ status }) =>
          isFinal(status) ? null : [{ type: "user_message", messageId: message.messageId, text: message.text }],
        );
        if (!appended) return { kind: "finished", status: (await loadRun(tx, viewer, runId))!.status } as const;
        return { kind: "added", seq: appended.events[0].seq, status: appended.status } as const;
      });
    } catch (error) {
      // The same message sent twice at once: the second insert hits the unique index. Try again to find the first.
      if (pgCode(error) !== "23505" || attempt >= 2) throw error;
    }
  }
}

export interface StartRun {
  /** The client's id for the run, so a retried start makes one run. */
  runId: string;
  kind?: RunKind;
  conversationId?: string | null;
  parentRunId?: string | null;
  caps?: Record<string, unknown>;
  message: NewMessage;
}

/**
 * Makes a `queued` run with its first message. Starting the same `runId` again adds nothing new: it's the same
 * run, and the message goes through `addMessage`'s idempotency.
 */
export async function startRun(db: Db, viewer: Viewer, start: StartRun): Promise<MessageResult> {
  await inTenant(db, viewer, (tx) =>
    tx
      .insert(runs)
      .values({
        id: start.runId,
        tenantId: viewer.tenantId,
        userId: viewer.userId,
        conversationId: start.conversationId ?? null,
        parentRunId: start.parentRunId ?? null,
        kind: start.kind ?? "chat",
        status: "queued",
        caps: start.caps ?? {},
      })
      .onConflictDoNothing(),
  );
  return addMessage(db, viewer, start.runId, start.message);
}

/** What a runner needs from the loop (lane A's `#learn/agent/loop`), already bound to the app's tools, model,
 * caps and budget. */
export interface RunnerLoop {
  decide(events: RunEvent[], run: RunRow): NextAction;
  modelTurn(
    context: AgentContext,
    ctx: { viewer: Viewer; run: RunRow; signal: AbortSignal },
  ): Promise<Extract<RunEventData, { type: "assistant_turn" }>>;
  /** Runs a turn's calls in parallel and returns their results in call order. A tool's failure is an `ok: false`
   * result; a throw (a halted run, an abort) stops the run. */
  runTools(
    calls: ToolCall[],
    ctx: { viewer: Viewer; run: RunRow; signal: AbortSignal },
  ): Promise<Extract<RunEventData, { type: "tool_result" }>[]>;
  /** Returns the compaction to append before a model turn, or null when the log is short enough. */
  compact?(events: RunEvent[], signal: AbortSignal): Promise<Extract<RunEventData, { type: "compaction" }> | null>;
}

export interface LoopSettings {
  model: ChatModel;
  tools: readonly AgentTool[];
  reasoningEffort: ReasoningEffort;
  /** The kill switch and the daily budget (`agentGuard` in `@/lib/agent-tools`). */
  guard?: RunGuard;
  maxOutputTokens?: number;
  compaction?: CompactionSettings;
  /** For the summaries. Low is enough to summarise. */
  compactionEffort?: ReasoningEffort;
}

/** Lane A's loop (`#learn/agent/loop`), bound to one viewer's tools, model and guard, as the runner calls it. The
 * run's caps are its `caps` column over `DEFAULT_CAPS`. */
export function createRunnerLoop(viewer: Viewer, settings: LoopSettings): RunnerLoop {
  const { model, tools, reasoningEffort, guard } = settings;
  return {
    decide: (events, run) =>
      decide(events, { ...DEFAULT_CAPS, ...(run.caps as Partial<Caps>) }, approvalNeeded(tools, viewer, run.id)),
    modelTurn: (context, { signal }) =>
      modelTurn(context, { model, tools, reasoningEffort, guard, signal, maxOutputTokens: settings.maxOutputTokens }),
    runTools: (calls, { run, signal }) => runTools(calls, { tools, viewer, runId: run.id, signal, guard }),
    compact: (events, signal) =>
      compact(
        events,
        { model, reasoningEffort: settings.compactionEffort ?? "low", abortSignal: signal },
        settings.compaction,
      ),
  };
}

export interface RunnerDeps {
  db: Db;
  loop: RunnerLoop;
  contextTokens?: number;
  approvalTtlMs?: number;
  now?: () => Date;
}

export type RunnerOutcome = "not-found" | "busy" | RunStatus;

/**
 * The in-request runner (sections 13 and 14): claim the run, then loop `decide`, do the work, append, until the
 * run waits or finishes. Every step reads the log again, so a message that lands mid-turn is seen next time
 * round. A model turn that loses the version race is thrown away and decided again (it didn't see what got in
 * first); tool results are appended anyway, since their side effects have happened.
 *
 * Only one runner works a run: claiming is the `queued`/`waiting` to `running` move, and a runner that finds the
 * run already `running` leaves it alone. A runner killed mid-turn leaves the run `running`; section 15's runners
 * resume it, this one can't.
 */
export async function driveRun(
  deps: RunnerDeps,
  viewer: Viewer,
  runId: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<RunnerOutcome> {
  const now = deps.now ?? (() => new Date());
  const tx = <T>(fn: (tx: Tx) => Promise<T>) => inTenant(deps.db, viewer, fn);
  let claimed = false;

  const tryAppend = async (version: number, events: RunEventData[], activeMs = 0) => {
    try {
      return await tx((t) => append(t, runId, version, events, { activeMs }));
    } catch (error) {
      if (error instanceof VersionConflictError) return null;
      throw error;
    }
  };

  let state: RunState | null = null;
  try {
    for (;;) {
      signal.throwIfAborted();
      state = await tx((t) => loadState(t, viewer, runId));
      if (!state) return "not-found";
      const { run, events } = state;
      if (isFinal(run.status)) return run.status;

      if (!claimed) {
        if (run.status === "running") return "busy";
        claimed = (await tryAppend(run.version, [{ type: "status", from: run.status, to: "running" }])) !== null;
        continue;
      }
      // Someone else moved it (a cancel, or another runner after we let go): stop.
      if (run.status !== "running") return run.status;

      const started = Date.now();
      const action = deps.loop.decide(events, run);
      switch (action.kind) {
        case "model": {
          const compaction = await deps.loop.compact?.(events, signal);
          if (compaction) {
            await tryAppend(run.version, [compaction], Date.now() - started);
            break;
          }
          const notes = await tx((t) => listNotes(t, viewer.userId));
          const context = buildContext(events, deps.contextTokens ?? DEFAULT_CONTEXT_TOKENS, {
            notes: notes.map((n) => n.text),
          });
          const turn = await deps.loop.modelTurn(context, { viewer, run, signal });
          if (!(await tryAppend(run.version, [turn], Date.now() - started))) {
            logger.info("model turn discarded after a version conflict", { runId });
          }
          break;
        }
        case "tools": {
          const results = await deps.loop.runTools(action.calls, { viewer, run, signal });
          const callIds = action.calls.map((c) => c.callId);
          await tx(async (t) => {
            const rows = await t.execute<{ call_id: string }>(sql`
              SELECT data ->> 'callId' AS call_id FROM run_events
              WHERE run_id = ${runId} AND type = 'tool_result' AND data ->> 'callId' IN (${sql.join(
                callIds.map((id) => sql`${id}`),
                sql`, `,
              )})`);
            const recorded = new Set(rows.map((row) => row.call_id));
            const fresh = results.filter((r) => !recorded.has(r.callId));
            if (fresh.length > 0) await appendRetrying(t, runId, () => fresh, Date.now() - started);
          });
          break;
        }
        case "approval": {
          const expiresAt = new Date(now().getTime() + (deps.approvalTtlMs ?? APPROVAL_TTL_MS));
          const done = await tx(async (t) => {
            const [row] = await t
              .insert(approvals)
              .values({
                tenantId: viewer.tenantId,
                runId,
                callId: action.call.callId,
                tool: action.call.tool,
                input: (action.call.input ?? null) as object,
                expiresAt,
              })
              .onConflictDoNothing()
              .returning({ id: approvals.id });
            const approvalId =
              row?.id ??
              (
                await t
                  .select({ id: approvals.id })
                  .from(approvals)
                  .where(and(eq(approvals.runId, runId), eq(approvals.callId, action.call.callId)))
              )[0].id;
            try {
              return await append(
                t,
                runId,
                run.version,
                [
                  { type: "approval_requested", approvalId, call: action.call, expiresAt: expiresAt.toISOString() },
                  { type: "status", from: "running", to: "waiting", reason: "approval" },
                ],
                { activeMs: Date.now() - started },
              );
            } catch (error) {
              if (error instanceof VersionConflictError) return null;
              throw error;
            }
          });
          if (done) return "waiting";
          break;
        }
        case "wait":
          if (await tryAppend(run.version, [{ type: "status", from: "running", to: "waiting" }])) return "waiting";
          break;
        case "finish": {
          const status = { type: "status", from: "running", to: action.status, reason: action.reason } as const;
          if (await tryAppend(run.version, [status], Date.now() - started)) return action.status;
          break;
        }
      }
    }
  } catch (error) {
    if (!claimed) throw error;
    logger.error("run failed", { error, runId });
    const failed = await tx(async (t) => {
      const latest = await loadRun(t, viewer, runId);
      if (!latest || isFinal(latest.status)) return latest?.status ?? "failed";
      const message = error instanceof Error ? error.message : String(error);
      await appendRetrying(t, runId, ({ status }) =>
        isFinal(status)
          ? null
          : [
              { type: "error", message, retryable: false },
              ...(status === "running"
                ? [
                    {
                      type: "status",
                      from: status,
                      to: signal.aborted ? "cancelled" : "failed",
                      reason: message,
                    } as const,
                  ]
                : []),
            ],
      );
      return (await loadRun(t, viewer, runId))!.status;
    });
    return failed;
  }
}
