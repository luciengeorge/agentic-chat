import { createHook, getWorkflowMetadata, sleep } from "workflow";
import { start } from "workflow/api";

import type { ToolCall } from "#learn/agent/types";

import {
  type Durable,
  driveRun,
  type RunSignal,
  RunSignals,
  runToken,
  type ToolOutcome,
} from "#learn/agent/durable-run";

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
import { childResultStep, doneToken, notifyDoneStep, prepareChildStep, runDone } from "./orchestrator-steps";

export { approvalToken, type RunSignal, runToken } from "#learn/agent/durable-run";

/**
 * An agent run as a Workflow (section 15.3): plan, then the work as steps, until the run finishes. Every decision
 * comes from the event log in Postgres; Workflow's own log only remembers which steps ran and what they returned.
 * The loop itself is `driveRun` (`#learn/agent/durable-run`); this binds the run, makes its hook, and hands the loop
 * its steps.
 *
 * The body is replayed from Workflow's log on every wake-up, so it must do the same thing each time: no I/O, no
 * clock, no randomness (all of that happens in steps); see docs/m2-contract.md.
 */
export async function agentRunWorkflow(tenantId: string, userId: string, runId: string) {
  "use workflow";

  const ref: RunRef = { tenantId, userId, runId };
  const { workflowRunId } = getWorkflowMetadata();
  if (!(await bindRun(ref, workflowRunId))) return { status: "duplicate" as const };

  using hook = createHook<RunSignal>({ token: runToken(runId) });
  const signals = new RunSignals(hook[Symbol.asyncIterator]());
  const controller = new AbortController();
  const durable: Durable = { createHook, sleep: (until) => sleep(until) };

  /**
   * A delegate call (section 16.3): the child run is made, its workflow started as a child workflow, and this run
   * waits on the hook the child resumes when it ends, then reads only its outcome. The hook exists before the child
   * starts, so the child can't end unheard. A cancel stops the wait; the cancel itself reaches the child too.
   */
  async function delegate(call: ToolCall, siblings: number, batch: number): Promise<ToolOutcome> {
    const prepared = await prepareChildStep(ref, call, siblings, batch);
    if (prepared.kind !== "child" || controller.signal.aborted) {
      return prepared.kind === "child" ? { kind: "skipped" } : prepared;
    }
    using done = runDone.create({ token: doneToken(prepared.childRunId) });
    await start(agentRunWorkflow, [tenantId, userId, prepared.childRunId]);
    const stopped = new Promise<"cancelled">((resolve) => {
      if (controller.signal.aborted) resolve("cancelled");
      controller.signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
    });
    if ((await Promise.race([done, stopped])) === "cancelled") return { kind: "skipped" };
    return childResultStep(ref, call, prepared.childRunId);
  }

  const status = await driveRun(
    {
      plan: () => planStep(ref),
      modelTurn: (version, signal) => modelTurnStep(ref, version, signal),
      tool: (call, signal) => toolStep(ref, call, signal),
      delegate,
      record: (results) => recordStep(ref, results),
      approval: (call, version) => approvalStep(ref, call, version),
      expire: (approvalId) => expireStep(ref, approvalId),
      fail: (reason) => failStep(ref, reason),
    },
    signals,
    controller,
    durable,
  );
  if (status === "not-found") return { status: "not-found" as const };
  await closeTokens();
  await notifyDoneStep(ref, status);
  return { status };
}
