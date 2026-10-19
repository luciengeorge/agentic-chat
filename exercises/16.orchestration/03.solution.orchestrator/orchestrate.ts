/**
 * An orchestrator with sub-agents (section 16.3). The parent run hands a self-contained sub-task to a child run
 * through the `delegate` tool, one call per child. Each child is a run of its own (`kind: subagent`, with
 * `parent_run_id`): its own event log, its own caps (a share of the parent's), the same user, and a read-only policy.
 * The parent sees only what the child finally says, and a child that fails comes back as a failed tool result.
 *
 * How a child runs is the runner's business: the Workflow runner starts it as a child workflow and waits on a hook
 * (`src/workflows/agent-run.ts`); a test drives it in memory through `runChild`.
 */
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import type { AgentTool, ChildUsage, RunEvent, RunStatus, ToolCall, ToolContext } from "#learn/agent/types";

import { type Caps, runUsage } from "#learn/agent/caps";
import { subagentMessage } from "#learn/agent/prompt";

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
  /** What it spent, which the parent's caps count. */
  usage?: ChildUsage;
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

/**
 * Each child's caps: what the parent has left of its tokens and tool calls (`used` is its `runUsage`, which counts
 * earlier children's spend), split between the children of one turn. Every call in the turn (`batch`, the delegate
 * calls included) comes off the tool calls first, since the parent's other calls in that turn spend from the same cap. Model turns and active time are the parent's, since children run side by side. A
 * parent with nothing left gives 0, so the child stops before its first turn.
 */
export function childCaps(
  parent: Caps,
  siblings: number,
  used: ChildUsage = { tokens: 0, toolCalls: 0 },
  batch = siblings,
): Caps {
  const n = Math.max(1, siblings);
  const share = (left: number) => Math.max(0, Math.floor(left / n));
  return {
    modelTurns: parent.modelTurns,
    toolCalls: share(parent.toolCalls - used.toolCalls - batch),
    tokens: share(parent.tokens - used.tokens),
    activeMs: parent.activeMs,
  };
}

/** The parent run, as far as starting a child goes. */
export interface ParentRun {
  runId: string;
  kind: "chat" | "automation" | "subagent";
  caps: Caps;
}

/** What a delegate call starts: the child run's id, caps and first message, or why it can't start one. */
export type ChildStart =
  | { kind: "child"; runId: string; caps: Caps; message: { messageId: "task"; text: string } }
  | { kind: "refused"; error: string };

/**
 * The child run a delegate call starts, or why none. A sub-agent can't delegate in turn (one level, so a tree
 * stays bounded). The child's id comes from the call, so a step that runs again finds the child it made. Its caps
 * are its share of what the parent has left (`used` is the parent's `runUsage`). Its first message frames the task
 * as a read-only research task: the parent's model wrote it, not the user, and a document may have steered it.
 */
export function childStart(
  parent: ParentRun,
  call: ToolCall,
  used: ChildUsage,
  siblings: number,
  batch = siblings,
): ChildStart {
  if (parent.kind === "subagent") {
    return { kind: "refused", error: "A sub-agent can't hand work to another sub-agent." };
  }
  const input = DelegateSchema.safeParse(call.input);
  if (!input.success) return { kind: "refused", error: "Invalid input: delegate takes { task }." };
  return {
    kind: "child",
    runId: childRunId(parent.runId, call.callId),
    caps: childCaps(parent.caps, siblings, used, batch),
    message: { messageId: "task", text: subagentMessage(input.data.task) },
  };
}

const FINAL: readonly RunStatus[] = ["succeeded", "failed", "cancelled", "timed_out"];

/** A finished child's outcome, from its events: its last status, the text of its last model turn, and what it
 * spent. */
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
  const { tokens, toolCalls } = runUsage(events);
  const usage = { tokens, toolCalls };
  return FINAL.includes(status) && status !== "succeeded"
    ? { status, summary, reason, usage }
    : { status, summary, usage };
}

/** The `tool_result` for a delegate call, from its child's outcome: only a child that succeeded is a success.
 * Either way it carries what the child spent, so the parent's caps count it. */
export function delegateResult(
  callId: string,
  runId: string,
  outcome: ChildOutcome,
):
  | { type: "tool_result"; callId: string; ok: true; output: ChildReport; usage?: ChildUsage }
  | {
      type: "tool_result";
      callId: string;
      ok: false;
      error: string;
      usage?: ChildUsage;
    } {
  const usage = outcome.usage ? { usage: outcome.usage } : {};
  if (outcome.status === "succeeded") {
    return { type: "tool_result", callId, ok: true, output: { runId, summary: outcome.summary }, ...usage };
  }
  const why = outcome.reason ? `: ${outcome.reason}` : "";
  return {
    type: "tool_result",
    callId,
    ok: false,
    error: `The sub-agent ${outcome.status.replace("_", " ")}${why}.`,
    ...usage,
  };
}

/** The delegate calls of a turn, in order. */
export const delegateCalls = (calls: readonly ToolCall[]) => calls.filter((c) => c.tool === DELEGATE_TOOL);

/**
 * The `delegate` tool. A read: the child is read-only (`subagentPolicy` in #learn/agent/policy denies every write,
 * remember and delegate), so a task a document talked the parent into can't write anything. Without `runChild`
 * (the in-request and queue runners), it answers that sub-agents need the Workflow runner.
 */
export function delegateTool(deps: { runChild?: RunChild } = {}): AgentTool<Delegate, ChildReport> {
  return {
    name: DELEGATE_TOOL,
    description:
      "Hand one self-contained research sub-task to a read-only sub-agent that works as the same user, and get back " +
      "its final answer. It can search, read documents and look people up; it can't send mail, share, remember or " +
      "delegate. Use it when a request splits into independent parts, such as one per document to compare: call it " +
      "once per part, in the same turn, so they run side by side. You see only each sub-agent's answer, not its " +
      "steps. Do any write yourself, as your plan says.",
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
