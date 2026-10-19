// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AgentTool, ToolCall } from "#learn/agent/types";

import { type RunGuard, RunHalted, runTools } from "#learn/agent/loop";
import { drive, inMemoryRun } from "#learn/agent/loop-testing";
import { AGENT_INSTRUCTIONS } from "#learn/agent/prompt";
import { recordedRun, replayAgentModel, replayGuard, replayTools } from "@/core/agent/loop-recorded";

const viewer = { tenantId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A tool that waits `ms` and logs when it finishes. */
const timed = (finished: string[]): AgentTool =>
  ({
    name: "wait",
    description: "Wait",
    input: z.object({ name: z.string(), ms: z.number() }),
    effect: "read",
    needsApproval: () => false,
    async execute({ name, ms }: { name: string; ms: number }) {
      await sleep(ms);
      finished.push(name);
      if (name === "broken") throw new Error("drive offline");
      return { name };
    },
  }) as AgentTool;
const wait = (callId: string, ms: number): ToolCall => ({ callId, tool: "wait", input: { name: callId, ms } });

describe("runTools", () => {
  it("runs a turn's calls together: the turn takes as long as its slowest call", async () => {
    const finished: string[] = [];
    const started = Date.now();
    await runTools([wait("a", 150), wait("b", 150), wait("c", 150)], { tools: [timed(finished)], viewer, runId: "r" });
    const took = Date.now() - started;
    expect(took, `three 150 ms calls took ${took} ms: one after the other would take 450`).toBeLessThan(300);
  });

  it("returns the results in call order, whatever order they finish in", async () => {
    const finished: string[] = [];
    const results = await runTools([wait("search", 120), wait("find", 5)], {
      tools: [timed(finished)],
      viewer,
      runId: "r",
    });
    expect(finished, "find finished first").toEqual(["find", "search"]);
    expect(
      results.map((r) => r.callId),
      "the log takes the order the model asked in, not the order the network picked",
    ).toEqual(["search", "find"]);
  });

  it("keeps every call's result when one of them fails", async () => {
    const results = await runTools([wait("broken", 30), wait("fine", 5)], { tools: [timed([])], viewer, runId: "r" });
    expect(results).toEqual([
      { type: "tool_result", callId: "broken", ok: false, error: "drive offline" },
      { type: "tool_result", callId: "fine", ok: true, output: { name: "fine" } },
    ]);
  });

  it("stops the run when a call is halted, after every call has settled", async () => {
    const finished: string[] = [];
    let calls = 0;
    const guard: RunGuard = {
      beforeModelTurn: async () => {},
      afterModelTurn: async () => {},
      beforeToolCall: async () => {
        if (calls++ === 1) throw new RunHalted("kill switch: incident 42");
      },
    };
    const outcome = await runTools([wait("a", 60), wait("b", 5)], {
      tools: [timed(finished)],
      viewer,
      runId: "r",
      guard,
    })
      .then(() => "resolved")
      .catch((error: unknown) => error);
    expect(outcome, "a halted call stops the run: throw it").toBeInstanceOf(RunHalted);
    expect(finished, "the other call was already running, and finished before runTools threw").toEqual(["a"]);
  });
});

describe("Grace's second turn", () => {
  it("logs the search before Tom's lookup, though the lookup was done 5.1 s sooner", async () => {
    const recording = recordedRun("kpc-terms");
    // The recorded durations, a hundredth as long: the search 51 ms, the lookup 0.07.
    const tools = replayTools("kpc-terms", { timeScale: 0.01 });
    const finished: string[] = [];
    const watched = tools.map((t) => ({
      ...t,
      execute: async (input: unknown, ctx: Parameters<AgentTool["execute"]>[1]) => {
        const output = await t.execute(input, ctx);
        finished.push(t.name);
        return output;
      },
    }));
    const run = inMemoryRun(recording.runId);
    run.append(recording.events[0].data);
    await drive(run, {
      model: replayAgentModel("kpc-terms").model,
      tools: watched,
      viewer: recording.viewer,
      instructions: AGENT_INSTRUCTIONS,
      guard: replayGuard("kpc-terms"),
      approve: () => "approved",
    });
    expect(finished.slice(1, 3), "the lookup finished first").toEqual(["find_person", "search_documents"]);
    const second = run.events.slice(4, 6).map(({ seq, data }) => [seq, data.type === "tool_result" && data.callId]);
    expect(second, "seq 5 is the search's result and seq 6 the lookup's, as the model asked").toEqual([
      [5, recording.tools[1].callId],
      [6, recording.tools[2].callId],
    ]);
    expect(run.events.map((e) => e.data)).toEqual(recording.events.map((e) => e.data));
  });
});
