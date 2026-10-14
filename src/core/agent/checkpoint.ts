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
import type { AgentContext } from "./context";
import type { NextAction, RunEvent, RunEventData, RunStatus, ToolCall } from "./types";

import { buildContext, DEFAULT_CONTEXT_TOKENS } from "./context";
import { RunHalted } from "./loop";

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
  /** Appends at `version`; false when another writer got there first, so the caller should decide again. */
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

/** Appends a turn's tool results in call order, skipping any call the log already answers. */
export async function recordResults(store: StepStore, results: ToolResult[], options: AppendOptions): Promise<void> {
  if (options.stepKey && (await store.wrote(options.stepKey))) return;
  await store.appendWith(({ events }) => {
    const answered = new Set(events.flatMap((e) => (e.data.type === "tool_result" ? [e.data.callId] : [])));
    const fresh = results.filter((r) => !answered.has(r.callId));
    return fresh.length > 0 ? fresh : null;
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
  const next = await plan(store, loop);
  if (next.kind !== "act") return next;
  const { action, version } = next;
  try {
    if (action.kind === "model") {
      await modelStep(store, loop, { ...options, version });
    } else if (action.kind === "tools") {
      if (!(await store.wrote(options.stepKey))) {
        const started = Date.now();
        const results = await loop.runTools(action.calls, options.signal);
        await recordResults(store, results, { stepKey: options.stepKey, activeMs: Date.now() - started });
      }
    } else {
      const approval = await store.requestApproval(action.call, version, { stepKey: options.stepKey });
      if (approval) return { kind: "waiting", approval };
    }
  } catch (error) {
    if (!(error instanceof RunHalted)) throw error;
    await failRun(store, error.reason);
    return { kind: "final", status: "failed" };
  }
  return { kind: "continue" };
}
