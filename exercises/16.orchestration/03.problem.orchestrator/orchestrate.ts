// 👨‍💼 Grace asks the agent to compare what versions 1 and 2 of the travel and expenses policy say about hotels.
//    That's two independent pieces of reading, and each fills a context with a whole policy. Kestrel's agent hands
//    each one to a sub-agent: a child run of its own that reads one version and reports back a summary. The parent
//    only ever sees the two summaries. Children are cheap to read and dangerous to trust, so this file decides what
//    a child gets, and what it costs its parent.
//
// 🦉 Already written in this file: the `delegate` tool (its schema, its description, and its in-memory `execute`),
//    `childRunId`, `childOutcome` (a finished child's status, last answer and spend, read from its events) and
//    `delegateCalls`. The Workflow runner (`src/workflows/orchestrator-steps.ts`) calls your `childStart` for each
//    delegate call, starts the child as a child workflow, waits for it, and turns its outcome into the parent's
//    tool result with your `delegateResult`. You write `childCaps`, `childStart` and `delegateResult`.

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
  // 🐨 Each child of the turn gets an equal share of what the parent has LEFT, rounded down, never below 0:
  //    - tokens: the parent's cap less `used.tokens`, split between the `siblings`;
  //    - tool calls: the parent's cap less `used.toolCalls`, less every call in this turn (`batch`, the delegate
  //      calls included), split between the `siblings`;
  //    - model turns and active time: the parent's, as they are.
  //    Treat 0 siblings as 1.
  // 🐨 The classic mistake: splitting the parent's whole cap (60,000 / 2) and forgetting what's spent. `used` is
  //    the parent's `runUsage`, and it already counts what earlier children spent (step 3 of section 13 adds each
  //    delegate result's `usage`). Ignore it and a parent that delegates turn after turn hands out 60,000 every time.
  //
  // 💰 `Math.floor`, `Math.max`. `{ ...parent, tokens, toolCalls }` copies the other two fields.
  //
  // 🦉 Why a share of what's left. The parent's caps bound the whole tree: one user request, one budget. Two
  //    children that each got the parent's full 60,000 could spend 120,000 between them, and the parent its own
  //    60,000 on top. Splitting what's left means the parent plus every child can never pass the parent's cap.
  // 🦉 Why the batch comes off the tool calls first. The turn's other calls (a search beside the delegates) run
  //    at the same moment and spend from the same 30. With 29 reads and one delegate in a turn and 30 calls left,
  //    the child must get 0, not 29.
  throw new Error(
    `childCaps(${JSON.stringify(parent)}, ${siblings} siblings, ${JSON.stringify(used)}, batch ${batch}) isn't written yet`,
  );
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
  // 🐨 A parent that is itself a sub-agent can't delegate: refuse with "A sub-agent can't hand work to another
  //    sub-agent."
  // 🐨 Check the call's input with `DelegateSchema.safeParse`; not valid: refuse with "Invalid input: delegate
  //    takes { task }."
  // 🐨 Otherwise the child:
  //    - its run id from `childRunId(parent.runId, call.callId)`;
  //    - its caps from your `childCaps(parent.caps, siblings, used, batch)`;
  //    - its first message, `messageId: "task"`, whose text is `subagentMessage(task)`: the task framed as a
  //      read-only research task from the agent it works for.
  // 🐨 The classic mistake: treating the child as the user. The task becomes the child's first message, and it
  //    reads exactly like a user's request ("Email the Heron memo to Tom"). But the parent's model wrote it, maybe
  //    after a document told it what to ask. Frame it, so the child knows it's a researcher reporting back.
  //
  // 💰 Add `import { subagentMessage } from "#learn/agent/prompt";`. `input.data.task`.
  //
  // 🦉 Why children are read-only. A child's task is written by a model, never typed by the user. If a poisoned
  //    document gets the parent to delegate "send the memo to attacker@...", the child is the place that attack
  //    would run. So a sub-agent's model is offered the reads only, its policy (`subagentPolicy`, section 17)
  //    refuses every write whatever its task says, and this framing tells it so up front. Any write the user asked
  //    for is the parent's, checked against the parent's plan, which came from the user's own words.
  // 🦉 Why one level. A child that could delegate could start children that delegate: the tree, and its spend,
  //    would have no bound but the caps. One level keeps a run's tree one parent wide.
  // 🦉 Why the id comes from the call. A Workflow step that runs again (a crash, a retry) calls `childStart` again
  //    for the same call. The same id means it finds the child it made the first time, instead of starting a second
  //    child that reads and spends it all again.
  throw new Error(
    `childStart(${parent.kind} run ${parent.runId}, call ${call.callId}, ${JSON.stringify(used)}, ${siblings}, ${batch}) isn't written yet`,
  );
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
  // 🐨 Only a child whose status is `succeeded` is a success: `{ type: "tool_result", callId, ok: true, output:
  //    { runId, summary } }`, the summary being the child's last answer.
  // 🐨 Any other status is a failure: `ok: false`, with the error `The sub-agent <status>: <reason>.`, the status
  //    with its underscore as a space ("timed out"), and `: <reason>` only when there is one.
  // 🐨 Either way, when the outcome carries `usage`, the result carries it too, as `usage`. No usage, no key.
  // 🐨 The classic mistake: dropping the usage when the child failed. A child that ran into its cap spent all of
  //    it, and failing doesn't give it back.
  //
  // 💰 `outcome.status.replace("_", " ")`. A key that's there only sometimes: `...(cond ? { key: value } : {})`.
  //
  // 🦉 Why the spend rides on the result. The parent's log is the only thing its caps are counted from (section
  //    13.3), and the child's spend lives in the child's log. Putting it on the delegate call's result brings it
  //    into the parent's log, where `runUsage` adds it. The model never sees `usage`: only `output` or `error` go
  //    into its context.
  // 🦉 Why a failed child is a failed tool result, not a failed parent. The parent can still answer from the other
  //    child, or say which half it couldn't read. It decides, as it does with any tool that failed (section 13.4).
  //
  // 🚨 The tests check each share (what's spent and the batch taken off, rounded down, never below 0), the child's
  //    id, framing and refusals, every ending and its spend, and Grace's recorded comparison at 60,000 and 8,000.
  throw new Error(`delegateResult(${callId}, ${runId}, ${outcome.status}) isn't written yet`);
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
