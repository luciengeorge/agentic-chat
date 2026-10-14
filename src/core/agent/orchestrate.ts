/**
 * An orchestrator with sub-agents (section 16.3). The parent run hands a self-contained sub-task to a child run
 * through the `delegate` tool, one call per child. Each child is a run of its own (`kind: subagent`, with
 * `parent_run_id`): its own event log, its own caps (a share of the parent's), the same user and the same policy.
 * The parent sees only what the child finally says, and a child that fails comes back as a failed tool result.
 *
 * How a child runs is the runner's business: the Workflow runner starts it as a child workflow and waits on a hook
 * (`src/workflows/agent-run.ts`); a test drives it in memory through `runChild`.
 */
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import type { Caps } from "./caps";
import type { AgentTool, RunEvent, RunStatus, ToolCall, ToolContext } from "./types";

export const DELEGATE_TOOL = "delegate";

export const DelegateSchema = z.object({
  task: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "The sub-task, self-contained: the sub-agent sees nothing else. Name the document or person exactly, and " +
        "say what to report back.",
    ),
});

export type Delegate = z.infer<typeof DelegateSchema>;

/** How a child run ended, as the parent sees it. */
export interface ChildOutcome {
  status: RunStatus;
  /** The child's last answer: the text of its final model turn. */
  summary: string;
  /** Why it didn't succeed, from its final status. */
  reason?: string;
}

/** Runs a child to its end and says how it went. Given only where children run in-process (tests). */
export type RunChild = (task: string, ctx: ToolContext) => Promise<ChildOutcome>;

/** What a child that succeeded gives back to the parent's model. */
export interface ChildReport {
  runId: string;
  summary: string;
}

const NAMESPACE = "7c0b8f0e-4d55-4c47-9d5b-3f9a1e0c2d16";

/** The child run's id: the same for the same call, so a step that runs again starts no second child. The UI
 * uses it too, to nest the child's timeline under the call. */
export const childRunId = (parentRunId: string, callId: string) => uuidv5(`${parentRunId}:${callId}`, NAMESPACE);

/** Each child's caps: the parent's tokens and tool calls split between the children of one turn. Model turns and
 * active time are the parent's, since children run side by side. */
export function childCaps(parent: Caps, siblings: number): Caps {
  const n = Math.max(1, siblings);
  return {
    modelTurns: parent.modelTurns,
    toolCalls: Math.max(1, Math.floor(parent.toolCalls / n)),
    tokens: Math.max(1, Math.floor(parent.tokens / n)),
    activeMs: parent.activeMs,
  };
}

const FINAL: readonly RunStatus[] = ["succeeded", "failed", "cancelled", "timed_out"];

/** A finished child's outcome, from its events: its last status, and the text of its last model turn. */
export function childOutcome(events: readonly RunEvent[]): ChildOutcome {
  let status: RunStatus = "queued";
  let reason: string | undefined;
  let summary = "";
  for (const { data } of events) {
    if (data.type === "status") {
      status = data.to;
      reason = data.reason;
    } else if (data.type === "assistant_turn" && data.text.trim()) {
      summary = data.text.trim();
    }
  }
  return FINAL.includes(status) && status !== "succeeded" ? { status, summary, reason } : { status, summary };
}

/** The `tool_result` for a delegate call, from its child's outcome: only a child that succeeded is a success. */
export function delegateResult(
  callId: string,
  runId: string,
  outcome: ChildOutcome,
):
  | { type: "tool_result"; callId: string; ok: true; output: ChildReport }
  | {
      type: "tool_result";
      callId: string;
      ok: false;
      error: string;
    } {
  if (outcome.status === "succeeded") {
    return { type: "tool_result", callId, ok: true, output: { runId, summary: outcome.summary } };
  }
  const why = outcome.reason ? `: ${outcome.reason}` : "";
  return { type: "tool_result", callId, ok: false, error: `The sub-agent ${outcome.status.replace("_", " ")}${why}.` };
}

/** The delegate calls of a turn, in order. */
export const delegateCalls = (calls: readonly ToolCall[]) => calls.filter((c) => c.tool === DELEGATE_TOOL);

/**
 * The `delegate` tool. A read: the child's own writes wait on the user's approval, under the same policy. Without
 * `runChild` (the in-request and queue runners), it answers that sub-agents need the Workflow runner.
 */
export function delegateTool(deps: { runChild?: RunChild } = {}): AgentTool<Delegate, ChildReport> {
  return {
    name: DELEGATE_TOOL,
    description:
      "Hand one self-contained sub-task to a sub-agent that has the same tools and works as the same user, and get " +
      "back its final answer. Use it when a request splits into independent parts, such as one per document to " +
      "compare: call it once per part, in the same turn, so they run side by side. You see only each sub-agent's " +
      "answer, not its steps.",
    input: DelegateSchema,
    effect: "read",
    needsApproval: () => false,
    execute: async ({ task }, ctx) => {
      if (!deps.runChild) throw new Error("Sub-agents only run on the Workflow runner (AGENT_RUNNER=workflow).");
      const runId = childRunId(ctx.runId, ctx.callId);
      const result = delegateResult(ctx.callId, runId, await deps.runChild(task, ctx));
      if (!result.ok) throw new Error(result.error);
      return result.output;
    },
  };
}
