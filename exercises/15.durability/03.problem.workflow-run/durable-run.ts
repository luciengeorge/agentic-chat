// 👨‍💼 The job queue works, but Kestrel would rather not run its own: Vercel Workflow does the same thing as a
//    service, with retries, sleeps that last days, and a dashboard. Grace's run becomes a workflow. Its body is
//    this loop; each piece of work is a Workflow step. When the server dies, Workflow runs the body again from the
//    top and it must arrive exactly where it stopped, with Postgres and Workflow still agreeing on what happened.

/**
 * The agent run's workflow body, as plain code (sections 15.3 to 15.5). `agentRunWorkflow` in
 * `src/workflows/agent-run.ts` hands it the run's steps and Workflow's `createHook` and `sleep`; this decides which
 * step runs next, what to wait on, and when to stop.
 *
 * It runs inside the workflow, which Workflow replays from the top on every wake-up, feeding back what each step
 * returned. So it must do the same thing every time: no database, no network, no clock or randomness for a
 * decision. Every decision comes from a step's result (the plan, read from Postgres) or a hook firing.
 */
import type { Hook } from "workflow";

import type { OpenApproval, Plan } from "#learn/agent/checkpoint";
import type { RunEventData, ToolCall } from "#learn/agent/types";

type ToolResult = Extract<RunEventData, { type: "tool_result" }>;

/** What wakes a run: something landed in its log (a message), or the user cancelled it. Ids only: the change is
 * already in Postgres. */
export type RunSignal = { kind: "wake" } | { kind: "cancel" };

/** The run's hook, keyed on the run id, for messages and cancels. */
export const runToken = (runId: string) => `agent-run:${runId}`;
/** An approval's hook, keyed on the approval id. Resumed after the decision commits. */
export const approvalToken = (approvalId: string) => `agent-approval:${approvalId}`;

/** The orchestrator's tool (`#learn/agent/orchestrate`). Named here: the body can't import modules with Node in them. */
export const DELEGATE_TOOL = "delegate";

export type ToolOutcome =
  | { kind: "result"; result: ToolResult }
  | { kind: "halted"; reason: string }
  | { kind: "skipped" };

/** The run's steps, as the body calls them. In the app each is a Workflow step (`src/workflows/agent-run-steps.ts`). */
export interface RunSteps {
  /** Reads the log and decides; makes the status-only moves (claim, wait, finish) itself. */
  plan(): Promise<Plan>;
  /** One model turn at `version`; `stale` when the log moved first. */
  modelTurn(version: number, signal: AbortSignal): Promise<"done" | "stale">;
  /** One tool call, with the step's own idempotency key. */
  tool(call: ToolCall, signal: AbortSignal): Promise<ToolOutcome>;
  /** A delegate call: a child run, waited on (section 16.3). */
  delegate(call: ToolCall, siblings: number, batch: number): Promise<ToolOutcome>;
  /** Appends a turn's results, in call order, once. */
  record(results: ToolResult[]): Promise<void>;
  /** Records the approval request and moves the run to waiting. */
  approval(call: ToolCall, version: number): Promise<unknown>;
  /** The approval's time ran out: settle it as expired, unless the user got there first. */
  expire(approvalId: string): Promise<boolean>;
  /** Ends the run `failed` with the reason. */
  fail(reason: string): Promise<void>;
}

/** Workflow's own waiting, handed in by the body: a hook by token, and a sleep until a date. */
export interface Durable {
  createHook<T>(options: { token: string }): Hook<T>;
  sleep(until: Date): Promise<void>;
}

/**
 * The run's hook, read one `next()` at a time. A race takes the read in flight (`pending`) and, once it has fired,
 * starts the next one (`taken`). A fresh `next()` per race would leave earlier ones waiting, and a signal could be
 * handed to a read nobody is listening to any more.
 */
export class RunSignals {
  private read: Promise<IteratorResult<RunSignal>>;

  constructor(private readonly incoming: AsyncIterator<RunSignal>) {
    this.read = incoming.next();
  }

  get pending(): Promise<IteratorResult<RunSignal>> {
    return this.read;
  }

  taken(): void {
    this.read = this.incoming.next();
  }
}

const isCancel = (signal: IteratorResult<RunSignal>) => signal.value?.kind === "cancel";

/**
 * The work, run to its end (step 5 races it against a cancel). Until then a cancel waits for the work in flight to
 * finish, and the next plan finds the run final.
 */
export async function unlessCancelled<T>(
  work: Promise<T>,
  _signals: RunSignals,
  _controller: AbortController,
): Promise<{ value: T } | null> {
  return { value: await work };
}

/**
 * Waits for the run's own hook: a message, a cancel, or the kick an approval's decision sends when nothing listens
 * on the approval's hook. Step 4 adds that hook, and the approval's 7-day expiry.
 */
export async function waitForChange(
  _approval: Pick<OpenApproval, "approvalId" | "expiresAt"> | null,
  _steps: RunSteps,
  signals: RunSignals,
  _durable: Durable,
): Promise<"cancel" | "changed"> {
  const signal = await signals.pending;
  signals.taken();
  return isCancel(signal) ? "cancel" : "changed";
}

/**
 * The run as a loop of steps (section 15.3): plan, then the work the plan calls for, until the run is final. A
 * turn's tool calls run as parallel steps, and their results are recorded together, in call order, by one more
 * step. Returns the status the run ended with: `cancelled` when a cancel stopped it, `failed` when a step failed
 * for good.
 */
export async function driveRun(
  steps: RunSteps,
  signals: RunSignals,
  controller: AbortController,
  durable: Durable,
): Promise<string> {
  // 🐨 Loop: `steps.plan()`, then do what it says, until the run is done.
  //    - `not-found`: return "not-found" at once.
  //    - `final`: the run is over, and its status is the answer.
  //    - `waiting`: `waitForChange(plan.approval, steps, signals, durable)`. "cancel" ends the run as "cancelled";
  //      anything else plans again.
  //    - `act`, an `approval`: `steps.approval(call, version)`, then plan again.
  //    - `act`, a `model` turn: `steps.modelTurn(version, controller.signal)`, inside
  //      `unlessCancelled(work, signals, controller)`. Null from that means a cancel stopped the run: "cancelled".
  //    - `act`, `tools`: every call at once, each its own step. A `delegate` call the policy didn't deny (it has no
  //      `denied` field) goes to `steps.delegate(call, <how many such calls>, <how many calls>)`, every other call
  //      to `steps.tool(call, controller.signal)`. Wait for them all inside `unlessCancelled`. If an outcome is
  //      `halted`, `steps.fail(<its reason>)`. Otherwise `steps.record(<the result outcomes' results>)`, once, in
  //      call order, unless there are none.
  // 🐨 A step that throws has failed for good: Workflow has already retried it. Catch it around the whole loop,
  //    `steps.fail(<its message>)`, and the run ends "failed". Nothing throws out of the body.
  //
  // 💰 `Promise.all(calls.map(...))` gives the results in the calls' order, whatever order they finish in.
  //    `outcomes.flatMap((o) => (o.kind === "result" ? [o.result] : []))`. `DELEGATE_TOOL` is the delegate's name.
  //
  // 🦉 Why every branch is on a step's result. This function runs inside the workflow, and Workflow runs it again
  //    from the top on every wake-up: after each step, after an approval, after a restart. A step that already ran
  //    doesn't run again: its recorded result comes straight back. So the loop walks the same path to where it
  //    stopped, then carries on. That only works if the path depends on nothing but those results. `plan` reads
  //    Postgres inside a step; this function only looks at what it returned.
  // 🦉 Two records, one truth. Workflow's log records which steps ran and what each returned; `run_events`
  //    records what happened to the run. The two can't commit together. So each step writes Postgres under its own
  //    key, `wf:<stepId>:<i>`: a step Workflow runs again (it never heard the first try finish) finds its key in
  //    `run_events` and writes nothing. And every decision is read from Postgres by `plan`, so the two records
  //    can't disagree about what to do next.
  // 🦉 Why one record step for a whole turn. The model reads results in the order it made the calls (13.5). Each
  //    tool step returns its result; one more step appends them all, in call order, under one key.
  //
  // 🚨 The tests drive the loop with fake steps (the order, parallel tools, one record, a halt, a failure, a
  //    wait, a cancel), then run Grace's recorded run through the real workflow.
  throw new Error(
    `driveRun(${typeof steps}, ${typeof signals}, ${controller.signal.aborted}, ${typeof durable}) isn't written yet`,
  );
}

export type KickAction = "start" | "wake" | "reconcile" | "replace" | "leave";

/**
 * What a kick does, from the run's workflow id (`runs.workflow_run_id`) and that workflow's status (`gone`: Workflow
 * has no such run; null: the status couldn't be read). Only a workflow that has surely ended is replaced: two live
 * workflows driving one run would each send its writes under their own step keys, so a write could go out twice.
 * - no workflow yet: start one;
 * - running or pending: wake it (a missing hook means it hasn't made it yet, and it reads the log once it has);
 * - cancelled outside the app: cancel the run to match;
 * - completed, failed or gone: replace it;
 * - status unknown: leave it, and let the next kick try again.
 */
export function kickAction(workflowRunId: string | null, status: string | null): KickAction {
  // 🐨 Something changed for the run (a message, an approval, a restart) and its workflow should hear about it.
  //    From the workflow id Postgres has for the run, and that workflow's status as Workflow reports it:
  //    - no workflow id yet: "start" one;
  //    - a status that couldn't be read (null): "leave" it;
  //    - "cancelled" (from outside the app: the Workflow CLI, `ex start`): "reconcile", which cancels the run to
  //      match;
  //    - "completed", "failed", or "gone" (Workflow has no such run): "replace" it;
  //    - anything else ("running", "pending"): "wake" it.
  //
  // 🚨 The classic mistake is to start a new workflow when the status can't be read. "Couldn't read it" isn't
  //    "it ended".
  //
  // 🦉 Why only a workflow that has surely ended is replaced. Two workflows driving one run would each send its
  //    writes under its own step ids, so its own idempotency keys, and fake-workspace would see two different
  //    mails. That race was found in M2's review: a kick that couldn't read the status started a second workflow
  //    while the first was alive. Leaving costs a delay: the next kick tries again, and `workflow_run_id` stays
  //    set until then.
  // 🦉 Why "wake" for a workflow whose hook isn't there yet. Between `bindRun` and `createHook` a workflow is alive
  //    without its hook, and a kick then finds no one to resume. It's not gone: once it makes its hook, its first
  //    plan reads the log, message included.
  // 🦉 Why a cancelled workflow isn't replaced. Someone meant it. Starting another would undo their cancel.
  //
  // 🚨 The tests check every case, and the Workflow test's approval goes through the app's waker, which asks this
  //    function before it resumes anything.
  throw new Error(`kickAction(${workflowRunId}, ${status}) isn't written yet`);
}
