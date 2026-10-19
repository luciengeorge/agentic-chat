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
 * `work`, unless a cancel comes first (section 15.5): then the work in flight is aborted through `controller`, and
 * this returns null once it has stopped. A wake (a message) while the work runs changes nothing: the next plan
 * reads it.
 */
export async function unlessCancelled<T>(
  work: Promise<T>,
  signals: RunSignals,
  controller: AbortController,
): Promise<{ value: T } | null> {
  for (;;) {
    const won = await Promise.race([
      work.then((value) => ({ work: true as const, value })),
      signals.pending.then((signal) => ({ work: false as const, signal })),
    ]);
    if (won.work) return { value: won.value };
    signals.taken();
    if (isCancel(won.signal)) {
      controller.abort("cancelled");
      await work.catch(() => {});
      return null;
    }
  }
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
  if (!approval) {
    const signal = await signals.pending;
    signals.taken();
    return isCancel(signal) ? "cancel" : "changed";
  }
  const decided = durable.createHook<unknown>({ token: approvalToken(approval.approvalId) });
  try {
    // Planning again registers the hook first: a decision that landed before it is now in the log.
    const again = await steps.plan();
    if (again.kind !== "waiting" || again.approval?.approvalId !== approval.approvalId) return "changed";
    const won = await Promise.race([
      decided.then(() => "decided" as const),
      durable.sleep(new Date(approval.expiresAt)).then(() => "expired" as const),
      signals.pending,
    ]);
    if (won === "expired") await steps.expire(approval.approvalId);
    else if (won !== "decided") {
      signals.taken();
      if (isCancel(won)) return "cancel";
    }
    return "changed";
  } finally {
    // Released whichever way the wait ends, so the next wait on this approval can take the token again.
    decided.dispose();
  }
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
        const delegates = action.calls.filter((call) => call.tool === DELEGATE_TOOL && !("denied" in call)).length;
        const done = await unlessCancelled(
          Promise.all(
            action.calls.map((call) =>
              call.tool === DELEGATE_TOOL && !("denied" in call)
                ? steps.delegate(call, delegates, action.calls.length)
                : steps.tool(call, controller.signal),
            ),
          ),
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
