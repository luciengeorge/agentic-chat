// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { AgentTool } from "#learn/agent/types";
import type { Retrieve } from "#learn/retrieve/types";
import type { RunnerLoop } from "@/lib/agent-runs";

import { appTelemetry, chatObserver, observedLoop, observedRetrieve, observedTools } from "./observability.server";

describe("the app's observability hooks, with nothing configured", () => {
  it("start no telemetry", () => {
    expect(appTelemetry({})).toBeNull();
  });

  it("hand back the very retrieve, tools and loop they were given, so the app runs exactly as before", () => {
    const retrieve: Retrieve = async (_viewer, query) => ({ query, rewritten: [], chunks: [], auditId: "a" });
    const tools: AgentTool[] = [];
    const loop = { decide: () => ({ kind: "wait" }) } as unknown as RunnerLoop;
    expect(observedRetrieve(retrieve, null)).toBe(retrieve);
    expect(observedTools(tools, null)).toBe(tools);
    expect(observedLoop(loop, null)).toBe(loop);
  });

  it("give the chat route no observer, so it takes the path it always took", () => {
    expect(chatObserver({}, null)).toBeUndefined();
  });
});
