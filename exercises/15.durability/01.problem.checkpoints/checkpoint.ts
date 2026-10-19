// 👨‍💼 Grace asks the agent to email Tom the payment terms of contract KPC-2026-0142. Her run takes a dozen
//    pieces of work: plan, search, read, draft, wait for her approval, send, answer. The server that runs them can
//    die between any two, or in the middle of one. When it comes back, the run must carry on from where it was,
//    without asking the model again for a turn it already has, and without doing any piece twice.

/**
 * A run advanced one checkpoint at a time (section 15.1). The checkpoint is the event log itself: each step reads
 * the log, decides, does one piece of work and appends what happened. A worker that dies mid-step leaves the log
 * as it was before the step, so whoever picks the run up next decides again from there and redoes only that step.
 *
 * Every write here is keyed by the step (`stepKey`), so a step that runs twice (a job retried after its lease ran
 * out, a Workflow step replayed after a crash) appends nothing twice. Side effects outside the log carry their own
 * idempotency key (`#learn/agent/durable`).
 *
 * The queue runner does `advance` once per job; the Workflow runner calls the pieces as separate steps.
 */
import type { AgentContext } from "#learn/agent/context";
import type { NextAction, RunEvent, RunEventData, RunStatus, ToolCall } from "#learn/agent/types";

import { buildContext, DEFAULT_CONTEXT_TOKENS } from "#learn/agent/context";

type AssistantTurn = Extract<RunEventData, { type: "assistant_turn" }>;
type ToolResult = Extract<RunEventData, { type: "tool_result" }>;
type Compaction = Extract<RunEventData, { type: "compaction" }>;

export interface Snapshot {
  status: RunStatus;
  version: number;
  events: RunEvent[];
}

export interface AppendOptions {
  /** The step writing: a second write under the same key is refused. */
  stepKey?: string;
  /** Running time to add to the run. */
  activeMs?: number;
}

export interface OpenApproval {
  approvalId: string;
  callId: string;
  expiresAt: string;
}

/** The run's log, as one viewer may touch it (the app binds it to Postgres and the viewer's tenant). */
export interface StepStore {
  load(): Promise<Snapshot | null>;
  /** Appends at `version`; false when another writer got there first, so the caller should decide again. An
   * `approval_decided` event settles its approval's row too, if it's still pending. */
  append(version: number, events: RunEventData[], options?: AppendOptions): Promise<boolean>;
  /** Appends what `build` returns from the latest log, reading again while other writers get in first. For events
   * that stay true whatever lands meanwhile. `build` returns null to write nothing. */
  appendWith(build: (snapshot: Snapshot) => RunEventData[] | null, options?: AppendOptions): Promise<boolean>;
  /** Whether a step under this key already wrote: it ran before, and its work is in the log. */
  wrote(stepKey: string): Promise<boolean>;
  /** Records an approval request (a row the user can decide, its event, and `running -> waiting`) at `version`;
   * null when another writer got there first. */
  requestApproval(call: ToolCall, version: number, options: AppendOptions): Promise<OpenApproval | null>;
  /** The user's memory notes, for the context. */
  notes(): Promise<string[]>;
}

/** Lane A's loop, bound to the run's tools, model, caps, guard and policy. */
export interface StepLoop {
  decide(events: RunEvent[]): NextAction;
  modelTurn(context: AgentContext, signal: AbortSignal, onTextDelta?: (delta: string) => void): Promise<AssistantTurn>;
  runTools(calls: ToolCall[], signal: AbortSignal): Promise<ToolResult[]>;
  compact?(events: RunEvent[], signal: AbortSignal): Promise<Compaction | null>;
}

const FINAL: readonly RunStatus[] = ["succeeded", "failed", "cancelled", "timed_out"];
export const isFinalStatus = (status: RunStatus) => FINAL.includes(status);

/** The approval the run is waiting on: requested, not yet decided. */
export function openApproval(events: readonly RunEvent[]): OpenApproval | null {
  const decided = new Set(events.flatMap((e) => (e.data.type === "approval_decided" ? [e.data.approvalId] : [])));
  for (let i = events.length - 1; i >= 0; i--) {
    const data = events[i].data;
    if (data.type === "approval_requested" && !decided.has(data.approvalId)) {
      return { approvalId: data.approvalId, callId: data.call.callId, expiresAt: data.expiresAt };
    }
  }
  return null;
}

export type Plan =
  | { kind: "not-found" }
  | { kind: "final"; status: RunStatus }
  | { kind: "waiting"; approval: OpenApproval | null }
  | { kind: "act"; version: number; action: Extract<NextAction, { kind: "model" | "tools" | "approval" }> };

const MAX_PLAN_ATTEMPTS = 20;

/**
 * Reads the log and decides, and makes the moves that are only a status change: claiming the run
 * (`queued`/`waiting` to `running`), waiting (`running` to `waiting`) and finishing. What's left is work for the
 * caller, at the returned version.
 */
export async function plan(store: StepStore, loop: StepLoop): Promise<Plan> {
  for (let attempt = 0; attempt < MAX_PLAN_ATTEMPTS; attempt++) {
    const snapshot = await store.load();
    if (!snapshot) return { kind: "not-found" };
    const { status, version, events } = snapshot;
    if (isFinalStatus(status)) return { kind: "final", status };

    const action = loop.decide(events);
    if (action.kind === "wait") {
      if (status === "waiting" || status === "queued") return { kind: "waiting", approval: openApproval(events) };
      if (await store.append(version, [{ type: "status", from: status, to: "waiting" }])) {
        return { kind: "waiting", approval: openApproval(events) };
      }
      continue;
    }
    const claim: RunEventData[] = status === "running" ? [] : [{ type: "status", from: status, to: "running" }];
    if (action.kind === "finish") {
      const finish: RunEventData = { type: "status", from: "running", to: action.status, reason: action.reason };
      if (await store.append(version, [...claim, finish])) return { kind: "final", status: action.status };
      continue;
    }
    if (claim.length > 0 && !(await store.append(version, claim))) continue;
    return { kind: "act", version: version + (claim.length > 0 ? 1 : 0), action };
  }
  throw new Error("too many writers at once: gave up deciding");
}

export interface ModelStepOptions {
  version: number;
  stepKey: string;
  signal: AbortSignal;
  contextTokens?: number;
  onTextDelta?: (delta: string) => void;
}

/**
 * One model turn (or, when the log has grown past the threshold, a compaction instead), appended under `stepKey`.
 * `stale` means the log moved since `plan` (a message came in): the turn is thrown away, to be decided again.
 */
export async function modelStep(
  store: StepStore,
  loop: StepLoop,
  options: ModelStepOptions,
): Promise<"done" | "stale"> {
  if (await store.wrote(options.stepKey)) return "done";
  const started = Date.now();
  const snapshot = await store.load();
  if (!snapshot || snapshot.version !== options.version) return "stale";
  const compaction = await loop.compact?.(snapshot.events, options.signal);
  if (compaction) {
    const ok = await store.append(options.version, [compaction], {
      stepKey: options.stepKey,
      activeMs: Date.now() - started,
    });
    return ok ? "done" : "stale";
  }
  const context = buildContext(snapshot.events, options.contextTokens ?? DEFAULT_CONTEXT_TOKENS, {
    notes: await store.notes(),
  });
  const turn = await loop.modelTurn(context, options.signal, options.onTextDelta);
  const ok = await store.append(options.version, [turn], { stepKey: options.stepKey, activeMs: Date.now() - started });
  return ok ? "done" : "stale";
}

/**
 * The approvals these results settle: a call that waited on its user and now has a result without a decision was
 * refused by the policy meanwhile (a new message needs a new plan). Its approval is rejected by nobody, as
 * "superseded", so the inbox stops offering it and approving it can't record a send that never happened. The store
 * settles the approval's row with the event.
 */
export function supersededApprovals(events: readonly RunEvent[], results: readonly ToolResult[]): RunEventData[] {
  const decided = new Set(events.flatMap((e) => (e.data.type === "approval_decided" ? [e.data.approvalId] : [])));
  const settled = new Set(results.map((r) => r.callId));
  return events.flatMap(({ data }) =>
    data.type === "approval_requested" && settled.has(data.call.callId) && !decided.has(data.approvalId)
      ? [
          {
            type: "approval_decided",
            approvalId: data.approvalId,
            decision: "rejected",
            by: null,
            reason: "superseded",
          },
        ]
      : [],
  );
}

/** Appends a turn's tool results in call order, skipping any call the log already answers, after settling any
 * approval they supersede. */
export async function recordResults(store: StepStore, results: ToolResult[], options: AppendOptions): Promise<void> {
  if (options.stepKey && (await store.wrote(options.stepKey))) return;
  await store.appendWith(({ events }) => {
    const answered = new Set(events.flatMap((e) => (e.data.type === "tool_result" ? [e.data.callId] : [])));
    const fresh = results.filter((r) => !answered.has(r.callId));
    return fresh.length > 0 ? [...supersededApprovals(events, fresh), ...fresh] : null;
  }, options);
}

/**
 * Ends the run `failed` with the reason, from wherever it is: a waiting or queued run goes through `running`, as
 * the state machine wants. A run that already finished stays as it is.
 */
export async function failRun(store: StepStore, reason: string, options: AppendOptions = {}): Promise<void> {
  if (options.stepKey && (await store.wrote(options.stepKey))) return;
  await store.appendWith(({ status }) => {
    if (isFinalStatus(status)) return null;
    const claim: RunEventData[] = status === "running" ? [] : [{ type: "status", from: status, to: "running" }];
    return [
      ...claim,
      { type: "error", message: reason, retryable: false },
      { type: "status", from: "running", to: "failed", reason },
    ];
  }, options);
}

export type StepOutcome =
  | { kind: "not-found" }
  | { kind: "final"; status: RunStatus }
  | { kind: "waiting"; approval: OpenApproval | null }
  | { kind: "continue" };

export interface AdvanceOptions {
  /** Unique to this step, stable if it runs again: the queue uses the job id. */
  stepKey: string;
  signal: AbortSignal;
  contextTokens?: number;
  onTextDelta?: (delta: string) => void;
}

/**
 * One checkpoint: plan, then the one piece of work it calls for, appended. `continue` means there's more to do
 * now; `waiting` means nothing until a message or a decision comes in. A halted run (the kill switch, the daily
 * budget) is failed here; any other throw is the caller's, to retry.
 */
export async function advance(store: StepStore, loop: StepLoop, options: AdvanceOptions): Promise<StepOutcome> {
  // 🐨 `plan` first: it reads the log, decides, and makes the status-only moves itself. Anything but `act` (no
  //    run, a final run, a run that's waiting) goes straight back to the caller.
  // 🐨 Then do the ONE piece of work the plan's action names, at the plan's version, under `options.stepKey`:
  //    - `model`: `modelStep`, with the options and the version (it checks the key itself);
  //    - `tools`: unless `store.wrote(options.stepKey)` says this step already wrote, run the calls with
  //      `loop.runTools(calls, options.signal)` and append them with `recordResults` under the same key. Pass
  //      `activeMs`, how long the tools took;
  //    - `approval`: `store.requestApproval(call, version, { stepKey })`. When it returns the approval, the run now
  //      waits: return `{ kind: "waiting", approval }`. Null means another writer got there first: carry on.
  //    Then return `{ kind: "continue" }`: there's more to do, and the caller queues it.
  // 🐨 The kill switch and the daily budget throw `RunHalted` from inside the loop. Catch it around the work, fail
  //    the run with its `reason` (`failRun`), and return `{ kind: "final", status: "failed" }`. Throw anything
  //    else on: whether to retry is the caller's call.
  //
  // 💰 `import { RunHalted } from "#learn/agent/loop";` at the top. `error instanceof RunHalted`, `error.reason`.
  // 💰 `Date.now()` before and after the tools gives `activeMs`.
  //
  // 🦉 Why the log is the checkpoint. A checkpoint is what you save so a crash can resume from it. Here nothing
  //    extra is saved: each piece of work appends what it did, in the same write that bumps the run's version,
  //    and the next piece starts by reading the log. A worker that dies mid-turn appended nothing, so whoever picks
  //    the run up reads the same log and decides the same next piece. A worker that dies after the append left a
  //    log that already says it, so the next plan decides the piece after. There is no other state to lose.
  // 🦉 Why one piece per call. A job holds a lease, and a lease can be lost. The less a job does, the less a crash
  //    throws away, and the sooner a cancel or a message is seen: each job starts with a fresh read of the log.
  // 🦉 Why the `wrote` check, when the version would refuse a second turn anyway. A job that comes back after its
  //    lease ran out has the same id, so the same step key. If its work is in the log, `plan` has moved on and
  //    asks for the next piece. Without the check, the redone job would do that next piece under its own name,
  //    and run tools that the next job (already queued) runs too. With it, a redone job finds `job:<id>:0` and
  //    stops: one job, one piece, at most once in the log.
  //
  // 🚨 The tests run Grace's recorded run one checkpoint at a time on Postgres: a fresh run's first checkpoint is
  //    its claim and one model turn; the same key again does nothing (no model call, no tool); the approval comes
  //    back as `waiting`; a `RunHalted` fails the run; a 503 goes back to the caller.
  throw new Error(`advance(${typeof store}, ${typeof loop}, step ${options.stepKey}) isn't written yet`);
}
