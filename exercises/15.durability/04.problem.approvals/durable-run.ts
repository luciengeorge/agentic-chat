// 👨‍💼 Grace's send waits for her approval. She might approve in a minute, from the inbox, or next Tuesday, or
//    never. Meanwhile the run must hold nothing (no worker, no open request), survive any number of restarts,
//    notice her decision at once, and give up on its own after 7 days.

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
 * Waits for whatever the run waits on (section 15.4): its approval (or the approval's expiry), a message, a cancel.
 * The approval's hook only wakes the run: what was decided is read from the log by the next plan.
 */
export async function waitForChange(
  approval: Pick<OpenApproval, "approvalId" | "expiresAt"> | null,
  steps: RunSteps,
  signals: RunSignals,
  durable: Durable,
): Promise<"cancel" | "changed"> {
  // 🐨 No approval (the run waits for a message): wait on the run's hook as before. `await signals.pending`, then
  //    `signals.taken()`; a cancel answers "cancel", anything else "changed".
  // 🐨 Waiting on an approval:
  //    1. make the approval's hook: `durable.createHook({ token: approvalToken(<its id>) })`, and dispose of it
  //       (`hook.dispose()`) in a `finally`, so it's released whichever way this ends;
  //    2. plan again (`steps.plan()`). Unless the run is still waiting on this same approval, something changed
  //       meanwhile: return "changed";
  //    3. race three things: the approval's hook, `durable.sleep(<expiresAt as a Date>)`, and the run's hook
  //       (`signals.pending`);
  //    4. the sleep won: `steps.expire(<the approval's id>)`. The run's hook won: `signals.taken()`, and a cancel
  //       answers "cancel". The approval's hook won: nothing to do, whatever it carried.
  //    Then answer "changed": the loop plans again, and the plan reads from Postgres what happened.
  //
  // 💰 `try { ... } finally { hook.dispose(); }` runs the dispose on every way out, returns included. (Not
  //    `using`: the dev server's transform can't load it in this file.)
  //    `hook.then(() => "decided" as const)`. `Promise.race([a, b, c])` settles with the first.
  // 💰 A signal from the run's hook is a cancel when `signal.value?.kind === "cancel"`.
  //
  // 🚨 The classic mistake is to decide from the hook's payload: approve because it says "approved". Anyone who
  //    can call the resume route can send any payload. The decision is the row in Postgres, written by
  //    `decideApproval` for the user who owns the approval; the hook only says "go and look".
  //
  // 🦉 Why the hook only wakes. A hook's token routes; it doesn't prove who sent it (docs/workflow-notes.md).
  //    `decideApproval` checks the viewer owns the approval, writes the decision to `approvals` and `run_events` in
  //    one transaction, and only then resumes the hook, with `{}`. So the run reads the decision from the same log
  //    as everything else, and a forged resume makes it plan, find nothing decided, and wait again.
  // 🦉 Why plan again after making the hook. A hook made by `createHook` is only registered when the workflow
  //    next stops to wait, and `steps.plan()` is such a stop. A decision that landed before the hook existed is
  //    already in the log, so this plan sees it. Without it, Grace could approve in the gap, the resume would
  //    find no hook, and the run would wait 7 days for a decision it already has.
  // 🦉 Why a sleep, and until `expiresAt`. Workflow's `sleep` is a timer in its own log: nothing runs while it
  //    waits, a restart doesn't reset it, and a test can end it early. Sleeping until the stored `expiresAt` makes
  //    the run expire when the approval row says, however many times the body was replayed. The body's clock
  //    can't do it: inside a workflow, `Date.now()` only moves when an event arrives.
  //
  // 🚨 The tests drive this with fake hooks and a fake clock (a decision before the hook, a forged payload, the
  //    expiry, a cancel), then run Grace's run in Workflow, approving it, and leaving it for 7 days.
  throw new Error(
    `waitForChange(${approval?.approvalId ?? "no approval"}, ${typeof steps}, ${typeof signals}, ${typeof durable}) isn't written yet`,
  );
}

/**
 * The step for each of a turn's calls (section 16.3's rule): a delegate the policy didn't deny becomes a child run,
 * told how many of the turn's calls are delegates and how many calls there are; any other call is a tool step.
 */
export function stepFor(
  steps: RunSteps,
  calls: readonly ToolCall[],
  signal: AbortSignal,
): (call: ToolCall) => Promise<ToolOutcome> {
  const delegated = (call: ToolCall) => call.tool === DELEGATE_TOOL && !("denied" in call);
  const delegates = calls.filter(delegated).length;
  return (call) => (delegated(call) ? steps.delegate(call, delegates, calls.length) : steps.tool(call, signal));
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
  let status: string = "running";
  try {
    for (;;) {
      const next = await steps.plan();
      if (next.kind === "not-found") return "not-found";
      if (next.kind === "final") {
        status = next.status;
        break;
      }
      if (next.kind === "waiting") {
        if ((await waitForChange(next.approval, steps, signals, durable)) === "cancel") {
          status = "cancelled";
          break;
        }
        continue;
      }
      const { action, version } = next;
      if (action.kind === "approval") {
        await steps.approval(action.call, version);
      } else if (action.kind === "model") {
        if (!(await unlessCancelled(steps.modelTurn(version, controller.signal), signals, controller))) {
          status = "cancelled";
          break;
        }
      } else {
        const done = await unlessCancelled(
          Promise.all(action.calls.map(stepFor(steps, action.calls, controller.signal))),
          signals,
          controller,
        );
        if (!done) {
          status = "cancelled";
          break;
        }
        const halted = done.value.find((outcome) => outcome.kind === "halted");
        if (halted?.kind === "halted") await steps.fail(halted.reason);
        else {
          const results = done.value.flatMap((outcome) => (outcome.kind === "result" ? [outcome.result] : []));
          if (results.length > 0) await steps.record(results);
        }
      }
    }
  } catch (error) {
    // A step that failed for good (a FatalError, or out of retries): the run fails with it.
    await steps.fail(error instanceof Error ? error.message : String(error));
    status = "failed";
  }
  return status;
}

export type KickAction = "start" | "wake" | "reconcile" | "replace" | "leave";

const ENDED = new Set(["completed", "failed"]);

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
  if (!workflowRunId) return "start";
  if (status === null) return "leave";
  if (status === "cancelled") return "reconcile";
  if (status === "gone" || ENDED.has(status)) return "replace";
  return "wake";
}
