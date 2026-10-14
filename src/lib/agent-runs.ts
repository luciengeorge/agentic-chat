import { and, eq, sql } from "drizzle-orm";

import type { Snapshot, StepLoop, StepStore } from "#learn/agent/checkpoint";
import type { AgentContext } from "#learn/agent/context";
import type { AgentTool, NextAction, RunEvent, RunEventData, RunStatus, Screen, ToolCall } from "#learn/agent/types";
import type { ChatModel, ReasoningEffort } from "#learn/model/types";
import type { Viewer } from "#learn/retrieve/types";
import type { Db } from "@/db/create";

import { type Caps, DEFAULT_CAPS } from "#learn/agent/caps";
import { compact, type CompactionSettings } from "#learn/agent/compact";
import { buildContext, DEFAULT_CONTEXT_TOKENS } from "#learn/agent/context";
import { backoffMs, isRetryable, withIdempotencyKey } from "#learn/agent/durable";
import { append, readEvents, VersionConflictError } from "#learn/agent/events";
import { approvalNeeded, decide, declinedResult, modelTurn, type RunGuard, runTools } from "#learn/agent/loop";
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
  /** The Workflow run driving it, when the workflow runner does. */
  workflowRunId: string | null;
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

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    workflowRunId: row.workflowRunId,
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

/** Why a runner should look at a run again. Payloads carry ids: the change itself is already in the log. */
export type Wake =
  | { kind: "message"; messageId: string }
  | { kind: "approval"; approvalId: string }
  | { kind: "cancel" };

/** Tells whichever runner holds the run (`AGENT_RUNNER`) that something changed. Called after the change commits. */
export type RunWaker = (viewer: Viewer, runId: string, wake: Wake) => Promise<void>;

/** The change is committed whatever the runner does with the news: a failed wake is logged, not thrown. */
async function wakeSafely(wake: RunWaker | undefined, viewer: Viewer, runId: string, why: Wake) {
  try {
    await wake?.(viewer, runId, why);
  } catch (error) {
    logger.error("waking the runner failed", { runId, wake: why.kind, error });
  }
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalRow {
  id: string;
  runId: string;
  conversationId: string | null;
  callId: string;
  tool: string;
  input: unknown;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  expiresAt: string;
  createdAt: string;
  /** The guardrails' verdict on the call, from its `approval_requested` event (lane D's screen). */
  screen: Screen | null;
}

const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());

/**
 * Settles an approval that's past its expiry: `expired`, with the call's declined result for the model. Only a
 * pending one changes, so whoever gets there first (the runner's timer, a late decision) does it once. Returns
 * whether it did. A runner whose own timer fired passes `timerFired`: the timer is the clock that counts (a test
 * wakes it early).
 */
export async function expireApproval(
  tx: Tx,
  approvalId: string,
  { now = new Date(), timerFired = false }: { now?: Date; timerFired?: boolean } = {},
): Promise<boolean> {
  const [row] = await tx.execute<{ run_id: string; call_id: string }>(sql`
    UPDATE approvals SET status = 'expired', decided_by = NULL, decided_at = ${now.toISOString()}::timestamptz
    WHERE id = ${approvalId} AND status = 'pending'
      AND (${timerFired}::boolean OR expires_at <= ${now.toISOString()}::timestamptz)
    RETURNING run_id, call_id`);
  if (!row) return false;
  await appendRetrying(tx, row.run_id, ({ status }) =>
    isFinal(status)
      ? null
      : [
          { type: "approval_decided", approvalId, decision: "expired", by: null },
          declinedResult(row.call_id, "expired"),
        ],
  );
  return true;
}

/**
 * The acting user approves or rejects one of their run's write actions. The row and the log change together; a
 * rejection also appends the call's declined result, so the model sees why. Another user's approval, or another
 * tenant's, is `not-found`; one already decided, expired, or on a finished run is `not-pending`. On `ok`, `wake`
 * tells the runner.
 */
export async function decideApproval(
  db: Db,
  viewer: Viewer,
  approvalId: string,
  decision: "approved" | "rejected",
  wake?: RunWaker,
): Promise<"ok" | "not-found" | "not-pending"> {
  if (!UUID.test(approvalId)) return "not-found";
  const now = new Date();
  const result = await inTenant(db, viewer, async (tx) => {
    const [row] = await tx.execute<{
      run_id: string;
      call_id: string;
      status: ApprovalStatus;
      expires_at: Date | string;
      user_id: string;
      run_status: RunStatus;
    }>(sql`
      SELECT a.run_id, a.call_id, a.status, a.expires_at, r.user_id, r.status AS run_status
      FROM approvals a JOIN runs r ON r.id = a.run_id
      WHERE a.id = ${approvalId}
      FOR UPDATE OF a`);
    if (!row || row.user_id !== viewer.userId) return { kind: "not-found" } as const;
    if (row.status !== "pending" || isFinal(row.run_status)) return { kind: "not-pending" } as const;
    if (new Date(row.expires_at) <= now) {
      // Too late: settle it as the runner's timer would have.
      await expireApproval(tx, approvalId, { now });
      return { kind: "expired", runId: row.run_id } as const;
    }
    await tx
      .update(approvals)
      .set({ status: decision, decidedBy: viewer.userId, decidedAt: now })
      .where(eq(approvals.id, approvalId));
    await appendRetrying(tx, row.run_id, ({ status }) =>
      isFinal(status)
        ? null
        : [
            { type: "approval_decided", approvalId, decision, by: viewer.userId },
            ...(decision === "rejected" ? [declinedResult(row.call_id, "rejected")] : []),
          ],
    );
    return { kind: "ok", runId: row.run_id } as const;
  });
  if (result.kind === "not-found" || result.kind === "not-pending") return result.kind;
  await wakeSafely(wake, viewer, result.runId, { kind: "approval", approvalId });
  return result.kind === "ok" ? "ok" : "not-pending";
}

/**
 * Cancels the viewer's run: its pending approvals are rejected (by them) and the run moves to `cancelled`, in one
 * transaction. `wake` then tells the runner, which aborts a model turn or tool call in flight. A finished run is
 * `final`; another user's or tenant's is `not-found`.
 */
export async function cancelRun(
  db: Db,
  viewer: Viewer,
  runId: string,
  wake?: RunWaker,
): Promise<"ok" | "not-found" | "final"> {
  if (!UUID.test(runId)) return "not-found";
  const result = await inTenant(db, viewer, async (tx) => {
    const run = await loadRun(tx, viewer, runId);
    if (!run) return "not-found" as const;
    if (isFinal(run.status)) return "final" as const;
    const pending = await tx
      .update(approvals)
      .set({ status: "rejected", decidedBy: viewer.userId, decidedAt: new Date() })
      .where(and(eq(approvals.runId, runId), eq(approvals.status, "pending")))
      .returning({ id: approvals.id });
    const appended = await appendRetrying(tx, runId, ({ status }) =>
      isFinal(status)
        ? null
        : [
            ...pending.map(
              (p) => ({ type: "approval_decided", approvalId: p.id, decision: "rejected", by: viewer.userId }) as const,
            ),
            { type: "status", from: status, to: "cancelled", reason: "cancelled by the user" },
          ],
    );
    return appended ? ("ok" as const) : ("final" as const);
  });
  if (result === "ok") await wakeSafely(wake, viewer, runId, { kind: "cancel" });
  return result;
}

/** The viewer's approvals, newest first (at most 100). `pending` keeps the ones still waiting on them: not
 * decided, not expired, on a run that hasn't finished. */
export async function listApprovals(db: Db, viewer: Viewer, status?: "pending"): Promise<ApprovalRow[]> {
  const rows = await inTenant(db, viewer, (tx) =>
    tx.execute<{
      id: string;
      run_id: string;
      conversation_id: string | null;
      call_id: string;
      tool: string;
      input: unknown;
      status: ApprovalStatus;
      decided_by: string | null;
      decided_at: Date | string | null;
      expires_at: Date | string;
      created_at: Date | string;
      screen: Screen | null;
    }>(sql`
      SELECT a.id, a.run_id, r.conversation_id, a.call_id, a.tool, a.input, a.status, a.decided_by, a.decided_at,
        a.expires_at, a.created_at,
        (SELECT e.data -> 'call' -> 'screen' FROM run_events e
         WHERE e.run_id = a.run_id AND e.type = 'approval_requested' AND e.data ->> 'approvalId' = a.id::text
         LIMIT 1) AS screen
      FROM approvals a JOIN runs r ON r.id = a.run_id
      WHERE r.user_id = ${viewer.userId}
      ${
        status === "pending"
          ? sql`AND a.status = 'pending' AND a.expires_at > now()
              AND r.status NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out')`
          : sql``
      }
      ORDER BY a.created_at DESC, a.id
      LIMIT 100`),
  );
  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    callId: row.call_id,
    tool: row.tool,
    input: row.input,
    status: row.status,
    decidedBy: row.decided_by,
    decidedAt: iso(row.decided_at),
    expiresAt: iso(row.expires_at)!,
    createdAt: iso(row.created_at)!,
    screen: row.screen ?? null,
  }));
}

/** What a runner needs from the loop (lane A's `#learn/agent/loop`), already bound to the app's tools, model,
 * caps and budget. */
export interface RunnerLoop {
  decide(events: RunEvent[], run: RunRow): NextAction;
  modelTurn(
    context: AgentContext,
    ctx: { viewer: Viewer; run: RunRow; signal: AbortSignal; onTextDelta?: (delta: string) => void },
  ): Promise<Extract<RunEventData, { type: "assistant_turn" }>>;
  /** Runs a turn's calls in parallel and returns their results in call order. A tool's failure is an `ok: false`
   * result; a throw (a halted run, an abort) stops the run. `idempotencyKey` replaces the one derived from the call
   * (Workflow passes its step's). */
  runTools(
    calls: ToolCall[],
    ctx: { viewer: Viewer; run: RunRow; signal: AbortSignal; idempotencyKey?: string },
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
    modelTurn: (context, { signal, onTextDelta }) =>
      modelTurn(context, {
        model,
        tools,
        reasoningEffort,
        guard,
        signal,
        onTextDelta,
        maxOutputTokens: settings.maxOutputTokens,
      }),
    runTools: (calls, { run, signal, idempotencyKey }) =>
      runTools(calls, {
        tools: idempotencyKey === undefined ? tools : withIdempotencyKey(tools, idempotencyKey),
        viewer,
        runId: run.id,
        signal,
        guard,
      }),
    compact: (events, signal) =>
      compact(
        events,
        { model, reasoningEffort: settings.compactionEffort ?? "low", abortSignal: signal, guard },
        settings.compaction,
      ),
  };
}

export interface StoreOptions {
  approvalTtlMs?: number;
  now?: () => Date;
}

const isConflict = (error: unknown) => error instanceof VersionConflictError || pgCode(error) === "23505";

/**
 * The run's log as `#learn/agent/checkpoint` reads and writes it, in Postgres and the viewer's tenant. Writes under
 * a step key are once only: the unique `(run_id, step_key)` refuses a second write, which counts as already done.
 */
export function runStore(db: Db, viewer: Viewer, runId: string, options: StoreOptions = {}): StepStore {
  const tx = <T>(fn: (tx: Tx) => Promise<T>) => inTenant(db, viewer, fn);
  const now = options.now ?? (() => new Date());
  const wrote = async (stepKey: string) => {
    const rows = await tx((t) =>
      t.execute(sql`SELECT 1 FROM run_events WHERE run_id = ${runId} AND step_key = ${`${stepKey}:0`}`),
    );
    return rows.length > 0;
  };
  const snapshot = async (t: Tx): Promise<Snapshot | null> => {
    const state = await loadState(t, viewer, runId);
    return state && { status: state.run.status, version: state.run.version, events: state.events };
  };

  return {
    load: () => tx(snapshot),
    wrote,
    async append(version, events, appendOptions = {}) {
      try {
        await tx((t) => append(t, runId, version, events, appendOptions));
        return true;
      } catch (error) {
        if (error instanceof VersionConflictError) return false;
        if (pgCode(error) === "23505" && appendOptions.stepKey) return true;
        throw error;
      }
    },
    async appendWith(build, appendOptions = {}) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await tx(async (t) => {
            const current = await snapshot(t);
            const events = current && build(current);
            if (!current || !events) return false;
            await append(t, runId, current.version, events, appendOptions);
            return true;
          });
        } catch (error) {
          if (pgCode(error) === "23505" && appendOptions.stepKey) return true;
          if (!isConflict(error) || attempt >= MAX_CONFLICT_RETRIES) throw error;
        }
      }
    },
    async requestApproval(call, version, appendOptions) {
      const existing = async () => {
        const current = await tx(snapshot);
        const event = current?.events.find(
          (e) => e.data.type === "approval_requested" && e.data.call.callId === call.callId,
        );
        if (!event || event.data.type !== "approval_requested") return null;
        return { approvalId: event.data.approvalId, callId: call.callId, expiresAt: event.data.expiresAt };
      };
      if (appendOptions.stepKey && (await wrote(appendOptions.stepKey))) return existing();
      const expiresAt = new Date(now().getTime() + (options.approvalTtlMs ?? APPROVAL_TTL_MS));
      try {
        return await tx(async (t) => {
          const approvalId = await approvalRow(t, viewer, runId, call, expiresAt);
          await append(
            t,
            runId,
            version,
            [
              { type: "approval_requested", approvalId, call, expiresAt: expiresAt.toISOString() },
              { type: "status", from: "running", to: "waiting", reason: "approval" },
            ],
            appendOptions,
          );
          return { approvalId, callId: call.callId, expiresAt: expiresAt.toISOString() };
        });
      } catch (error) {
        if (pgCode(error) === "23505" && appendOptions.stepKey) return existing();
        if (isConflict(error)) return null;
        throw error;
      }
    },
    notes: async () => (await tx((t) => listNotes(t, viewer.userId))).map((n) => n.text),
  };
}

/** Inserts the approval row for a call, or finds the one an earlier attempt made. */
async function approvalRow(tx: Tx, viewer: Viewer, runId: string, call: ToolCall, expiresAt: Date): Promise<string> {
  const [row] = await tx
    .insert(approvals)
    .values({
      tenantId: viewer.tenantId,
      runId,
      callId: call.callId,
      tool: call.tool,
      input: (call.input ?? null) as object,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: approvals.id });
  if (row) return row.id;
  const [found] = await tx
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.runId, runId), eq(approvals.callId, call.callId)));
  return found.id;
}

/** The runner's loop as `#learn/agent/checkpoint` calls it, bound to one run. */
export function stepLoop(loop: RunnerLoop, viewer: Viewer, run: RunRow): StepLoop {
  return {
    decide: (events) => loop.decide(events, run),
    modelTurn: (context, signal, onTextDelta) => loop.modelTurn(context, { viewer, run, signal, onTextDelta }),
    runTools: (calls, signal) => loop.runTools(calls, { viewer, run, signal }),
    compact: loop.compact && ((events, signal) => loop.compact!(events, signal)),
  };
}

export interface RunnerDeps {
  db: Db;
  loop: RunnerLoop;
  contextTokens?: number;
  approvalTtlMs?: number;
  now?: () => Date;
  /** The wait before trying a step again after a retryable error, doubled each time. */
  retryBaseMs?: number;
}

const LIVE = Symbol.for("agentic-chat.live-runs");

/** The runs this process is working on, so a cancel can abort the one in flight. Process-wide, like the pools. */
function liveRuns(): Map<string, Set<AbortController>> {
  const store = globalThis as typeof globalThis & { [LIVE]?: Map<string, Set<AbortController>> };
  return (store[LIVE] ??= new Map());
}

/** Marks a run as worked on here until `release()`; aborting it (`abortLive`) aborts `signal`. */
export function holdLive(runId: string): { signal: AbortSignal; release(): void } {
  const controller = new AbortController();
  const held = liveRuns().get(runId) ?? new Set();
  held.add(controller);
  liveRuns().set(runId, held);
  return {
    signal: controller.signal,
    release() {
      held.delete(controller);
      if (held.size === 0 && liveRuns().get(runId) === held) liveRuns().delete(runId);
    },
  };
}

/** Aborts whatever this process is doing for the run. Returns how many workers it reached. */
export function abortLive(runId: string, reason = "cancelled"): number {
  const held = liveRuns().get(runId);
  for (const controller of held ?? []) controller.abort(new DOMException(reason, "AbortError"));
  return held?.size ?? 0;
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
  let retries = 0;

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
      try {
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
      } catch (error) {
        // A 429, a 5xx or a dropped connection: record it and go round again. `decide` gives up after three.
        if (signal.aborted || !isRetryable(error)) throw error;
        retries += 1;
        logger.warn("retrying after an error", { runId, error, retries });
        const message = error instanceof Error ? error.message : String(error);
        await tx((t) =>
          appendRetrying(t, runId, ({ status }) =>
            status === "running" ? [{ type: "error", message, retryable: true }] : null,
          ),
        );
        await pause(backoffMs(retries, deps.retryBaseMs ?? 1_000), signal);
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
