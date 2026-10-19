/**
 * A parent run and its two sub-agents, recorded once on gpt-6-luna (medium effort) on 2026-10-19 by a script that
 * isn't committed. It ran `driveTree` (`#learn/agent/orchestrate-testing`) with the app's six tools, its guard and
 * real retrieval on the dev database, as grace.adeyemi: "Compare what versions 1 and 2 of the travel and expenses
 * policy say about hotels. Hand each version to its own sub-agent." The file holds each run's model requests and
 * raw server-sent events, and each run's event log.
 *
 * The parent planned (no writes), then made two `delegate` calls in one turn, one per version. Each child got
 * 28,824 tokens and 13 tool calls, searched, read its version, and reported; the parent wrote the comparison from
 * the two summaries alone. Section 16.3 and the orchestration lab replay it, so nothing there calls a model.
 *
 * Replaying answers each run's nth model call with that run's nth recorded reply, whatever the request says, and
 * each tool call with what that call id returned.
 */
import { createOpenAI } from "@ai-sdk/openai";

import type { Caps } from "#learn/agent/caps";
import type { RunGuard } from "#learn/agent/loop";
import type { AgentTool, RunEvent } from "#learn/agent/types";
import type { ChatModel } from "#learn/model/types";
import type { Viewer } from "#learn/retrieve/types";

import { PLAN_TOOL } from "#learn/agent/plan";
import { createAgentTools } from "#learn/agent/tools/index";
import { aiSdkChatModel } from "#learn/model/ai-sdk";
import { CHAT_MODEL } from "#learn/model/config";
import { chunkedBody } from "@/core/model/cassette";

import hotelsCompare from "../../../fixtures/cassettes/agent/hotels-compare.json?raw";

interface RecordedTurn {
  request: Record<string, unknown>;
  sse: string;
  ms: number;
}

export interface RecordedChild {
  callId: string;
  task: string;
  runId: string;
  caps: Caps;
  events: RunEvent[];
  turns: RecordedTurn[];
}

export interface TreeRecording {
  recorded: string;
  name: "hotels-compare";
  user: string;
  message: string;
  model: string;
  reasoningEffort: string;
  viewer: Viewer;
  runId: string;
  outcome: { kind: string; status?: string; reason?: string };
  events: RunEvent[];
  turns: RecordedTurn[];
  /** In the order they finished. */
  children: RecordedChild[];
}

export function treeRecording(): TreeRecording {
  return JSON.parse(hotelsCompare) as TreeRecording;
}

/** The recorded child a delegate call started. */
export function recordedChild(callId: string): RecordedChild {
  const child = treeRecording().children.find((c) => c.callId === callId);
  if (!child) throw new Error(`the recording has no sub-agent for call ${callId}`);
  return child;
}

function replayModel(turns: RecordedTurn[], requests: Array<Record<string, unknown>>): ChatModel {
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const turn = turns[requests.length];
    requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    if (!turn) throw new Error(`the recording has ${turns.length} model calls for this run; it was called again`);
    init?.signal?.throwIfAborted();
    return new Response(chunkedBody(new TextEncoder().encode(turn.sse)), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const openai = createOpenAI({ apiKey: "replay", fetch: fetch as typeof globalThis.fetch });
  return aiSdkChatModel(openai(CHAT_MODEL));
}

/**
 * gpt-6-luna for each run of the tree, answering from that run's recording: the parent (`callId` null), or the
 * child a delegate call started. `requests` holds what each run sent, keyed the same way.
 */
export function replayTreeModels(): {
  modelFor: (callId: string | null) => ChatModel;
  requests: Map<string | null, Array<Record<string, unknown>>>;
} {
  const recording = treeRecording();
  const requests = new Map<string | null, Array<Record<string, unknown>>>();
  const models = new Map<string | null, ChatModel>();
  return {
    requests,
    modelFor(callId) {
      if (!models.has(callId)) {
        const sent: Array<Record<string, unknown>> = [];
        requests.set(callId, sent);
        models.set(callId, replayModel(callId === null ? recording.turns : recordedChild(callId).turns, sent));
      }
      return models.get(callId)!;
    },
  };
}

/**
 * The app's six tools, as recorded, answering each call with what that call id returned in any run of the tree. A
 * `make_plan` the recording has no result for runs as itself.
 */
export function replayTreeTools(): AgentTool[] {
  const recording = treeRecording();
  const results = new Map(
    [recording.events, ...recording.children.map((c) => c.events)]
      .flat()
      .flatMap(({ data }) => (data.type === "tool_result" ? [[data.callId, data] as const] : [])),
  );
  const unused = async () => {
    throw new Error("a replayed tool reaches nothing");
  };
  return createAgentTools({ withTenant: unused, retrieve: unused, workspace: unused }).map((tool) => ({
    ...tool,
    async execute(input, ctx) {
      const result = results.get(ctx.callId);
      if (!result && tool.name === PLAN_TOOL) return tool.execute(input, ctx);
      if (!result) throw new Error(`the recording has no result for ${tool.name} call ${ctx.callId}`);
      if (!result.ok) throw new Error(result.error);
      return result.output;
    },
  }));
}

/** A guard that spends nothing: the tree has no writes to screen. */
export const replayTreeGuard: RunGuard = {
  beforeModelTurn: async () => {},
  afterModelTurn: async () => {},
  beforeToolCall: async () => {},
  screen: async (calls) => calls.map(() => ({})),
};

/** Where each child's clock started when it was recorded, so a replay's events carry the same times. */
export const recordedChildClock = (callId: string) => Date.parse(recordedChild(callId).events[0].at) - 1000;

/** Where the parent's clock started. */
export const RECORDED_PARENT_CLOCK = Date.parse("2026-10-19T09:00:00Z");
