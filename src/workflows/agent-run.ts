import { createHook, getWorkflowMetadata, sleep } from "workflow";

import {
  approvalStep,
  bindRun,
  closeTokens,
  expireStep,
  failStep,
  modelTurnStep,
  planStep,
  recordStep,
  type RunRef,
  toolStep,
} from "./agent-run-steps";

/** What wakes a run: something landed in its log (a message), or the user cancelled it. Ids only: the change is
 * already in Postgres. */
export type RunSignal = { kind: "wake" } | { kind: "cancel" };

/** The run's hook, keyed on the run id, for messages and cancels. */
export const runToken = (runId: string) => `agent-run:${runId}`;
/** An approval's hook, keyed on the approval id. Resumed after the decision commits. */
export const approvalToken = (approvalId: string) => `agent-approval:${approvalId}`;

/**
 * An agent run as a Workflow (section 15.3): plan, then the work as steps, until the run finishes. Every decision
 * comes from the event log in Postgres; Workflow's own log only remembers which steps ran and what they returned.
 *
 * The body is replayed from Workflow's log on every wake-up, so it must do the same thing each time: no I/O, no
 * clock, no randomness (all of that happens in steps); see docs/m2-contract.md.
 */
export async function agentRunWorkflow(tenantId: string, userId: string, runId: string) {
  "use workflow";

  const ref: RunRef = { tenantId, userId, runId };
  const { workflowRunId } = getWorkflowMetadata();
  if (!(await bindRun(ref, workflowRunId))) return { status: "duplicate" as const };

  using signals = createHook<RunSignal>({ token: runToken(runId) });
  const incoming = signals[Symbol.asyncIterator]();
  // One pending read of the run's hook, raced as long as it hasn't fired (never a fresh `next()` per race).
  let nextSignal = incoming.next();
  const controller = new AbortController();

  /** `work`, unless a cancel comes first: then the work in flight is aborted and this returns null. */
  async function unlessCancelled<T>(work: Promise<T>): Promise<{ value: T } | null> {
    for (;;) {
      const won = await Promise.race([
        work.then((value) => ({ work: true as const, value })),
        nextSignal.then((signal) => ({ work: false as const, signal })),
      ]);
      if (won.work) return { value: won.value };
      nextSignal = incoming.next();
      if (won.signal.value?.kind === "cancel") {
        controller.abort("cancelled");
        await work.catch(() => {});
        return null;
      }
    }
  }

  /** Waits for whatever the run waits on: its approval (or the approval's expiry), a message, a cancel. */
  async function waitForChange(
    approval: { approvalId: string; expiresAt: string } | null,
  ): Promise<"cancel" | "changed"> {
    if (!approval) {
      const signal = await nextSignal;
      nextSignal = incoming.next();
      return signal.value?.kind === "cancel" ? "cancel" : "changed";
    }
    using decided = createHook<unknown>({ token: approvalToken(approval.approvalId) });
    // Planning again registers the hook first: a decision that landed before it is now in the log.
    const again = await planStep(ref);
    if (again.kind !== "waiting" || again.approval?.approvalId !== approval.approvalId) return "changed";
    const won = await Promise.race([
      decided.then(() => "decided" as const),
      sleep(new Date(approval.expiresAt)).then(() => "expired" as const),
      nextSignal.then((signal) => signal),
    ]);
    if (won === "expired") await expireStep(ref, approval.approvalId);
    else if (won !== "decided") {
      nextSignal = incoming.next();
      if (won.value?.kind === "cancel") return "cancel";
    }
    return "changed";
  }

  let status: string = "running";
  try {
    for (;;) {
      const next = await planStep(ref);
      if (next.kind === "not-found") return { status: "not-found" as const };
      if (next.kind === "final") {
        status = next.status;
        break;
      }
      if (next.kind === "waiting") {
        if ((await waitForChange(next.approval)) === "cancel") {
          status = "cancelled";
          break;
        }
        continue;
      }
      const { action, version } = next;
      if (action.kind === "approval") {
        await approvalStep(ref, action.call, version);
      } else if (action.kind === "model") {
        if (!(await unlessCancelled(modelTurnStep(ref, version, controller.signal)))) {
          status = "cancelled";
          break;
        }
      } else {
        const done = await unlessCancelled(
          Promise.all(action.calls.map((call) => toolStep(ref, call, controller.signal))),
        );
        if (!done) {
          status = "cancelled";
          break;
        }
        const halted = done.value.find((outcome) => outcome.kind === "halted");
        if (halted?.kind === "halted") await failStep(ref, halted.reason);
        else {
          const results = done.value.flatMap((outcome) => (outcome.kind === "result" ? [outcome.result] : []));
          if (results.length > 0) await recordStep(ref, results);
        }
      }
    }
  } catch (error) {
    // A step that failed for good (a FatalError, or out of retries): the run fails with it.
    await failStep(ref, error instanceof Error ? error.message : String(error));
    status = "failed";
  }
  await closeTokens();
  return { status };
}
