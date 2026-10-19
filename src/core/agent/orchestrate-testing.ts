/**
 * An orchestrator in memory (section 16.3), for tests, the orchestration lab and the recorder: a parent run whose
 * delegate calls start child runs, as the Workflow runner does (`src/workflows/agent-run.ts` and
 * `orchestrator-steps.ts`), with no database and no workflow. Each delegate call goes through `childStart`, the
 * child runs read-only on its own log with its own caps, and its outcome comes back through `childOutcome` and
 * `delegateResult`, spend and all. Every other call runs as `drive` runs it.
 */
import type { AgentTool, RunEvent, ToolCall } from "#learn/agent/types";
import type { ChatModel, ReasoningEffort } from "#learn/model/types";
import type { Viewer } from "#learn/retrieve/types";

import { type Caps, DEFAULT_CAPS, runUsage } from "#learn/agent/caps";
import { supersededApprovals } from "#learn/agent/checkpoint";
import { buildContext } from "#learn/agent/context";
import {
  approvalNeeded,
  decide,
  declinedResult,
  modelTurn,
  type RunGuard,
  RunHalted,
  runTools,
} from "#learn/agent/loop";
import { drive, type InMemoryRun, inMemoryRun } from "#learn/agent/loop-testing";
import {
  type ChildOutcome,
  childOutcome,
  childStart,
  DELEGATE_TOOL,
  delegateResult,
  delegateTool,
} from "#learn/agent/orchestrate";
import { subagentPolicy, subagentTools } from "#learn/agent/policy";
import { AGENT_INSTRUCTIONS } from "#learn/agent/prompt";

/** One child of the tree: the call that started it, what it was given, and how it ended. */
export interface TreeChild {
  callId: string;
  task: string;
  runId: string;
  caps: Caps;
  events: RunEvent[];
  outcome: ChildOutcome;
}

export interface TreeOptions {
  /** The model for the parent (`callId` null) or for the child a delegate call starts. */
  modelFor: (callId: string | null) => ChatModel;
  /** The app's tools, without `delegate`: the parent gets them all plus `delegate`, a child the reads. */
  tools: readonly AgentTool[];
  viewer: Viewer;
  caps?: Caps;
  instructions?: string;
  reasoningEffort?: ReasoningEffort;
  guard?: RunGuard;
  /** Answers each of the parent's approvals at once; without it the parent stops at the first one. */
  approve?: (call: ToolCall) => "approved" | "rejected";
  /** Each child's clock starts here (milliseconds), so its events' times are stable. */
  childClock?: (callId: string) => number;
}

export interface Tree {
  last: Awaited<ReturnType<typeof drive>>;
  children: TreeChild[];
}

/** Runs the parent until it waits or finishes, its children with it, and returns its last action and its tree. */
export async function driveTree(parent: InMemoryRun, options: TreeOptions): Promise<Tree> {
  const { viewer, guard, caps = DEFAULT_CAPS } = options;
  const instructions = options.instructions ?? AGENT_INSTRUCTIONS;
  const reasoningEffort = options.reasoningEffort ?? "low";
  const tools = [...options.tools, delegateTool() as AgentTool];
  const needsApproval = approvalNeeded(tools, viewer, parent.runId);
  const children: TreeChild[] = [];

  async function delegate(call: ToolCall, siblings: number, batch: number) {
    const start = childStart(
      { runId: parent.runId, kind: "chat", caps },
      call,
      runUsage(parent.events),
      siblings,
      batch,
    );
    if (start.kind === "refused")
      return { type: "tool_result" as const, callId: call.callId, ok: false as const, error: start.error };
    const child = inMemoryRun(start.runId, options.childClock?.(call.callId));
    child.append({ type: "user_message", ...start.message });
    await drive(child, {
      model: options.modelFor(call.callId),
      tools: subagentTools(options.tools),
      policy: subagentPolicy,
      viewer,
      caps: start.caps,
      guard,
      instructions,
      reasoningEffort,
    });
    const outcome = childOutcome(child.events);
    children.push({
      callId: call.callId,
      task: (call.input as { task: string }).task,
      runId: child.runId,
      caps: start.caps,
      events: child.events,
      outcome,
    });
    return delegateResult(call.callId, child.runId, outcome);
  }

  for (let step = 0; step < 100; step++) {
    const action = decide(parent.events, caps, needsApproval);
    try {
      switch (action.kind) {
        case "model":
          parent.append(
            await modelTurn(buildContext(parent.events, undefined, { instructions }), {
              model: options.modelFor(null),
              tools,
              reasoningEffort,
              guard,
            }),
          );
          break;
        case "tools": {
          const isDelegate = (call: ToolCall) => call.tool === DELEGATE_TOOL && !("denied" in call);
          const siblings = action.calls.filter(isDelegate).length;
          const others = action.calls.filter((call) => !isDelegate(call));
          const [rest, delegated] = await Promise.all([
            runTools(others, { tools, viewer, runId: parent.runId, guard }),
            Promise.all(action.calls.filter(isDelegate).map((call) => delegate(call, siblings, action.calls.length))),
          ]);
          const byCall = new Map([...rest, ...delegated].map((result) => [result.callId, result]));
          const results = action.calls.map((call) => byCall.get(call.callId)!);
          parent.append(...supersededApprovals(parent.events, results), ...results);
          break;
        }
        case "approval": {
          const approvalId = `approval-${action.call.callId}`;
          parent.append({
            type: "approval_requested",
            approvalId,
            call: action.call,
            expiresAt: "2026-10-21T09:00:00Z",
          });
          if (!options.approve) return { last: action, children };
          const decision = options.approve(action.call);
          parent.append({ type: "approval_decided", approvalId, decision, by: viewer.userId });
          if (decision === "rejected") parent.append(declinedResult(action.call.callId, decision));
          break;
        }
        case "wait":
          return { last: action, children };
        case "finish":
          parent.append({ type: "status", from: "running", to: action.status, reason: action.reason });
          return { last: action, children };
      }
    } catch (error) {
      if (!(error instanceof RunHalted)) throw error;
      parent.append({ type: "status", from: "running", to: "failed", reason: error.reason });
      return { last: { kind: "finish" as const, status: "failed" as const, reason: error.reason }, children };
    }
  }
  throw new Error("the run didn't stop in 100 steps");
}
