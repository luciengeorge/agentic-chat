/**
 * The loop lab (section 13): one recorded agent run, replayed step by step through `#learn/agent/*`, so it shows
 * the learner's `decide`, `modelTurn`, `runTools` and caps while a section 13 step is active. Each step is one
 * decision and what was done about it, with the caps used once it was appended. The model and the tools answer
 * from the recording (`@/core/agent/loop-recorded`); approvals are granted at once. Nothing calls a model.
 */
import type { RunEventData, ToolCall } from "#learn/agent/types";

import { type Caps, DEFAULT_CAPS, type RunUsage, runUsage } from "#learn/agent/caps";
import { buildContext } from "#learn/agent/context";
import { approvalNeeded, decide, modelTurn, RunHalted, runTools } from "#learn/agent/loop";
import { inMemoryRun } from "#learn/agent/loop-testing";
import { AGENT_INSTRUCTIONS } from "#learn/agent/prompt";
import { recordedRun, replayAgentModel, replayGuard, replayTools, type RunName } from "@/core/agent/loop-recorded";

export interface LabCall {
  callId: string;
  tool: string;
  /** The input as the model wrote it, as JSON. */
  input: string;
}

export interface LabResult {
  callId: string;
  tool: string;
  ok: boolean;
  /** The output or the error, as the model reads it, cut to 600 characters. */
  text: string;
}

export interface LoopLabStep {
  /** What `decide` said. */
  decision: "model" | "tools" | "approval" | "wait" | "finish";
  turn?: { planning: boolean; inputTokens: number; outputTokens: number; text: string; calls: LabCall[] };
  results?: LabResult[];
  approval?: LabCall;
  finish?: { status: string; reason: string | null };
  /** Thrown by the code under test (a stub not written yet, say): the replay stops here. */
  error?: string;
  /** What the run had used once this step's events were in. */
  usage: RunUsage;
  /** The seq of the last event this step appended. */
  seq: number;
}

export interface LoopLab {
  name: RunName;
  user: string;
  message: string;
  recorded: string;
  caps: Caps;
  steps: LoopLabStep[];
  events: number;
  /** The recorded run's own outcome, to compare. */
  recordedEvents: number;
}

const cut = (text: string, max = 600) => (text.length > max ? `${text.slice(0, max)}…` : text);
const show = (value: unknown) => cut(typeof value === "string" ? value : JSON.stringify(value));
const callsOf = (calls: readonly ToolCall[]): LabCall[] =>
  calls.map(({ callId, tool, input }) => ({ callId, tool, input: JSON.stringify(input) }));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Replays a recording through the learner's loop, the way `drive` does, keeping each step. */
export async function stepThroughRun(name: RunName, caps: Caps = DEFAULT_CAPS): Promise<LoopLab> {
  const recording = recordedRun(name);
  const { model } = replayAgentModel(name);
  const tools = replayTools(name);
  const guard = replayGuard(name);
  const run = inMemoryRun(recording.runId, Date.parse(recording.events[0].at) - 1000);
  run.append(recording.events[0].data);
  const steps: LoopLabStep[] = [];
  const done = (step: Omit<LoopLabStep, "usage" | "seq">) =>
    steps.push({ ...step, usage: runUsage(run.events), seq: run.events.at(-1)?.seq ?? 0 });

  for (let i = 0; i < 40; i++) {
    let action;
    try {
      action = decide(run.events, caps, approvalNeeded(tools, recording.viewer, run.runId));
    } catch (error) {
      done({ decision: "wait", error: `decide threw: ${message(error)}` });
      break;
    }
    try {
      if (action.kind === "model") {
        const planning = run.events.at(-1)?.data.type === "user_message";
        const turn = await modelTurn(buildContext(run.events, undefined, { instructions: AGENT_INSTRUCTIONS }), {
          model,
          tools,
          reasoningEffort: "medium",
          guard,
        });
        run.append(turn);
        done({
          decision: "model",
          turn: {
            planning,
            inputTokens: turn.usage.inputTokens ?? 0,
            outputTokens: turn.usage.outputTokens ?? 0,
            text: turn.text,
            calls: callsOf(turn.toolCalls),
          },
        });
      } else if (action.kind === "tools") {
        const results = await runTools(action.calls, { tools, viewer: recording.viewer, runId: run.runId, guard });
        run.append(...results);
        const names = new Map(action.calls.map((c) => [c.callId, c.tool]));
        done({
          decision: "tools",
          results: results.map((r) => ({
            callId: r.callId,
            tool: names.get(r.callId) ?? "?",
            ok: r.ok,
            text: r.ok ? show(r.output) : r.error,
          })),
        });
      } else if (action.kind === "approval") {
        const approvalId = `approval-${action.call.callId}`;
        const decided: RunEventData[] = [
          { type: "approval_requested", approvalId, call: action.call, expiresAt: "2026-10-26T09:00:00Z" },
          { type: "approval_decided", approvalId, decision: "approved", by: recording.viewer.userId },
        ];
        run.append(...decided);
        done({ decision: "approval", approval: callsOf([action.call])[0] });
      } else if (action.kind === "finish") {
        run.append({ type: "status", from: "running", to: action.status, reason: action.reason });
        done({ decision: "finish", finish: { status: action.status, reason: action.reason ?? null } });
        break;
      } else {
        done({ decision: "wait" });
        break;
      }
    } catch (error) {
      if (error instanceof RunHalted) {
        run.append({ type: "status", from: "running", to: "failed", reason: error.reason });
        done({ decision: action.kind, finish: { status: "failed", reason: error.reason } });
      } else {
        done({ decision: action.kind, error: message(error) });
      }
      break;
    }
  }

  return {
    name,
    user: recording.user,
    message: recording.message,
    recorded: recording.recorded,
    caps,
    steps,
    events: run.events.length,
    recordedEvents: recording.events.length,
  };
}
