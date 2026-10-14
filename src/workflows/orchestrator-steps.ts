/**
 * The orchestrator's steps (section 16.3): a parent run's `delegate` call becomes a child run with its own log and
 * caps, driven by its own workflow, and the parent waits on a hook the child resumes when it ends. The child's id
 * comes from the call, so a step that runs again finds the child it made the first time.
 */
import { defineHook } from "workflow";
import { RetryableError } from "workflow";
import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";

import type { ToolCall } from "#learn/agent/types";
import type { Viewer } from "#learn/retrieve/types";

import { type Caps, DEFAULT_CAPS } from "#learn/agent/caps";
import { childCaps, childOutcome, childRunId, delegateResult, DelegateSchema } from "#learn/agent/orchestrate";
import { isFinal } from "#learn/agent/state";
import { withTenantOn } from "@/db/tenant";
import { loadRun, loadState, startRun } from "@/lib/agent-runs";
import { agentRuntime } from "@/lib/agent-runtime";

import type { RunRef, ToolOutcome } from "./agent-run-steps";

/** What a run says when it ends, to whoever waits on it: a parent run, or an automation's fan-out. */
export interface RunDone {
  status: string;
}

export const runDone = defineHook<RunDone>();

/** The hook a waiter makes before it starts a run, and the run resumes when it ends. */
export const doneToken = (runId: string) => `agent-done:${runId}`;

const viewerOf = (ref: RunRef): Viewer => ({ tenantId: ref.tenantId, userId: ref.userId });

export type PreparedChild = { kind: "child"; childRunId: string } | ToolOutcome;

/**
 * Makes the child run for a delegate call: `kind: subagent`, the parent as `parent_run_id`, the same user, the
 * call's task as its first message, and a share of the parent's caps. A sub-agent can't delegate in turn, and a
 * kill switch or spent budget halts the parent instead.
 */
export async function prepareChildStep(ref: RunRef, call: ToolCall, siblings: number): Promise<PreparedChild> {
  "use step";
  const { db, admit } = agentRuntime();
  const viewer = viewerOf(ref);
  const fail = (error: string): ToolOutcome => ({
    kind: "result",
    result: { type: "tool_result", callId: call.callId, ok: false, error },
  });
  const parent = await withTenantOn(db, ref.tenantId, (tx) => loadRun(tx, viewer, ref.runId));
  if (!parent || isFinal(parent.status)) return { kind: "skipped" };
  if (parent.kind === "subagent") return fail("A sub-agent can't hand work to another sub-agent.");
  const input = DelegateSchema.safeParse(call.input);
  if (!input.success) return fail("Invalid input: delegate takes { task }.");
  const halted = await admit?.(viewer);
  if (halted) return { kind: "halted", reason: halted };

  const id = childRunId(ref.runId, call.callId);
  const caps = childCaps({ ...DEFAULT_CAPS, ...(parent.caps as Partial<Caps>) }, siblings);
  await startRun(db, viewer, {
    runId: id,
    kind: "subagent",
    parentRunId: ref.runId,
    caps: { ...caps },
    message: { messageId: "task", text: input.data.task },
  });
  return { kind: "child", childRunId: id };
}

/** The child's outcome as the parent's tool result: its final answer, or a failure. */
export async function childResultStep(ref: RunRef, call: ToolCall, childId: string): Promise<ToolOutcome> {
  "use step";
  const { db } = agentRuntime();
  const state = await withTenantOn(db, ref.tenantId, (tx) => loadState(tx, viewerOf(ref), childId));
  if (!state) {
    return {
      kind: "result",
      result: { type: "tool_result", callId: call.callId, ok: false, error: "The sub-agent's run is gone." },
    };
  }
  return { kind: "result", result: delegateResult(call.callId, childId, childOutcome(state.events)) };
}

/**
 * Tells whoever waits on the run that it ended. Nobody waiting is fine. A parent that's still live must hear it,
 * though, so a missing hook there is retried: the parent makes its hook before it starts the child, but the hook
 * may not be visible yet.
 */
export async function notifyDoneStep(ref: RunRef, status: string): Promise<void> {
  "use step";
  try {
    await resumeHook(doneToken(ref.runId), { status } satisfies RunDone);
  } catch (error) {
    if (!HookNotFoundError.is(error)) throw error;
    const { db } = agentRuntime();
    const run = await withTenantOn(db, ref.tenantId, (tx) => loadRun(tx, viewerOf(ref), ref.runId));
    if (!run?.parentRunId) return;
    const parentId = run.parentRunId;
    const parent = await withTenantOn(db, ref.tenantId, (tx) => loadRun(tx, viewerOf(ref), parentId));
    if (parent && !isFinal(parent.status)) {
      throw new RetryableError("the parent run's hook isn't there yet", { retryAfter: 1000 });
    }
  }
}
notifyDoneStep.maxRetries = 5;
