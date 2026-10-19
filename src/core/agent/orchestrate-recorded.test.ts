// @vitest-environment node
import { describe, expect, it } from "vitest";

import { DEFAULT_CAPS, runUsage } from "#learn/agent/caps";
import { inMemoryRun } from "#learn/agent/loop-testing";
import { AGENT_INSTRUCTIONS } from "#learn/agent/prompt";
import { routeMessage } from "#learn/agent/router";

import {
  RECORDED_PARENT_CLOCK,
  recordedChildClock,
  replayTreeGuard,
  replayTreeModels,
  replayTreeTools,
  treeRecording,
} from "./orchestrate-recorded";
import { driveTree } from "./orchestrate-testing";
import { replayRouterModel, routerRecording } from "./router-recorded";

describe("the recorded hotel comparison", () => {
  it("replays through driveTree into the same events, each run sending the same requests", async () => {
    const recording = treeRecording();
    const { modelFor, requests } = replayTreeModels();
    const parent = inMemoryRun(recording.runId, RECORDED_PARENT_CLOCK);
    parent.append(recording.events[0].data);
    const { last, children } = await driveTree(parent, {
      modelFor,
      tools: replayTreeTools(),
      viewer: recording.viewer,
      caps: DEFAULT_CAPS,
      instructions: AGENT_INSTRUCTIONS,
      reasoningEffort: "medium",
      guard: replayTreeGuard,
      childClock: recordedChildClock,
    });
    expect(last).toEqual(recording.outcome);
    expect(parent.events).toEqual(recording.events);
    // A change to the prompt, the context, a tool's schema or the sub-agent's framing shows here first: re-record.
    expect(requests.get(null)).toEqual(recording.turns.map((t) => t.request));
    for (const child of recording.children) {
      const replayed = children.find((c) => c.callId === child.callId)!;
      expect(replayed.runId).toBe(child.runId);
      expect(replayed.caps).toEqual(child.caps);
      expect(replayed.events).toEqual(child.events);
      expect(requests.get(child.callId)).toEqual(child.turns.map((t) => t.request));
    }
  });

  it("keeps the numbers the READMEs quote", () => {
    const recording = treeRecording();
    const turns = (events: typeof recording.events) =>
      events.flatMap(({ data }) =>
        data.type === "assistant_turn" ? [[data.usage.inputTokens, data.usage.outputTokens]] : [],
      );
    expect(turns(recording.events)).toEqual([
      [2033, 105],
      [2117, 130],
      [3026, 406],
    ]);
    const [v1, v2] = ["version 1", "version 2"].map((v) => recording.children.find((c) => c.task.includes(v))!);
    expect(turns(v1.events)).toEqual([
      [999, 135],
      [3109, 72],
      [5712, 475],
    ]);
    expect(turns(v2.events)).toEqual([
      [999, 105],
      [3087, 73],
      [6184, 360],
    ]);
    expect(v1.caps).toEqual({ ...DEFAULT_CAPS, tokens: 28_824, toolCalls: 13 });
    expect([runUsage(v1.events).tokens, runUsage(v2.events).tokens]).toEqual([6394, 6722]);
    expect(runUsage(recording.events)).toMatchObject({ tokens: 16_783, toolCalls: 7, modelTurns: 3 });
  });
});

describe("the recorded router", () => {
  it("rebuilds each recorded request exactly and gets the recorded decision", async () => {
    for (const [index, call] of routerRecording().calls.entries()) {
      const { model, requests } = replayRouterModel(index);
      expect(await routeMessage(call.input, { model, reasoningEffort: "low" })).toEqual(call.decision);
      expect(requests).toEqual([call.request]);
    }
  });
});
