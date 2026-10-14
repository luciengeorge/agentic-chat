/**
 * A runner for tests and scripts: the loop over an in-memory event log, with no database. It shows the shape every
 * runner has: decide, do the work, append, until the action is to wait or finish.
 */
import type { ChatMessage, ChatModel, ReasoningEffort } from "#learn/model/types";
import type { Viewer } from "#learn/retrieve/types";

import type { AgentTool, RunEvent, RunEventData, ToolCall } from "./types";

import { type Caps, DEFAULT_CAPS } from "./caps";
import { approvalNeeded, decide, declinedResult, modelTurn, type RunGuard, RunHalted, runTools } from "./loop";

export interface InMemoryRun {
  runId: string;
  events: RunEvent[];
  append(...data: RunEventData[]): void;
}

export function inMemoryRun(runId = "run-1", start = Date.parse("2026-10-14T09:00:00Z")): InMemoryRun {
  const events: RunEvent[] = [];
  let clock = start;
  return {
    runId,
    events,
    append(...data) {
      for (const d of data)
        events.push({ runId, seq: events.length + 1, at: new Date((clock += 1000)).toISOString(), data: d });
    },
  };
}

/** The events as messages, the simplest way: no compaction, no memory, no budget (lane B's `buildContext` does it right). */
export function naiveContext(events: readonly RunEvent[]): ChatMessage[] {
  const names = new Map<string, string>();
  const messages: ChatMessage[] = [];
  for (const { data } of events) {
    if (data.type === "user_message") messages.push({ role: "user", content: data.text });
    else if (data.type === "assistant_turn") {
      for (const call of data.toolCalls) names.set(call.callId, call.tool);
      messages.push({
        role: "assistant",
        content: data.text,
        toolCalls: data.toolCalls.map((c) => ({ callId: c.callId, name: c.tool, input: c.input })),
      });
    } else if (data.type === "tool_result") {
      messages.push({
        role: "tool",
        callId: data.callId,
        toolName: names.get(data.callId) ?? "unknown",
        ...(data.ok ? { output: data.output } : { output: data.error, isError: true }),
      });
    }
  }
  return messages;
}

export interface DriveOptions {
  model: ChatModel;
  tools: readonly AgentTool[];
  viewer: Viewer;
  instructions?: string;
  /** Low unless set: tests don't care, and a live run picks its own. */
  reasoningEffort?: ReasoningEffort;
  caps?: Caps;
  guard?: RunGuard;
  /** Answers each approval at once; without it the run stops at the first one. */
  approve?: (call: ToolCall) => "approved" | "rejected";
  onTextDelta?: (delta: string) => void;
}

/** Runs until the loop says wait or finish, and returns that last action. */
export async function drive(run: InMemoryRun, options: DriveOptions) {
  const { tools, viewer, caps = DEFAULT_CAPS, guard } = options;
  const needsApproval = approvalNeeded(tools, viewer, run.runId);
  for (let step = 0; step < 100; step++) {
    const action = decide(run.events, caps, needsApproval);
    try {
      switch (action.kind) {
        case "model":
          run.append(
            await modelTurn(
              { instructions: options.instructions ?? "You are a helpful agent.", messages: naiveContext(run.events) },
              {
                model: options.model,
                tools,
                reasoningEffort: options.reasoningEffort ?? "low",
                guard,
                onTextDelta: options.onTextDelta,
              },
            ),
          );
          break;
        case "tools":
          run.append(...(await runTools(action.calls, { tools, viewer, runId: run.runId, guard })));
          break;
        case "approval": {
          const approvalId = `approval-${action.call.callId}`;
          run.append({ type: "approval_requested", approvalId, call: action.call, expiresAt: "2026-10-21T09:00:00Z" });
          if (!options.approve) return action;
          const decision = options.approve(action.call);
          run.append({ type: "approval_decided", approvalId, decision, by: viewer.userId });
          if (decision === "rejected") run.append(declinedResult(action.call.callId, decision));
          break;
        }
        case "wait":
          return action;
        case "finish":
          run.append({ type: "status", from: "running", to: action.status, reason: action.reason });
          return action;
      }
    } catch (error) {
      if (!(error instanceof RunHalted)) throw error;
      run.append({ type: "status", from: "running", to: "failed", reason: error.reason });
      return { kind: "finish" as const, status: "failed" as const, reason: error.reason };
    }
  }
  throw new Error("the run didn't stop in 100 steps");
}
