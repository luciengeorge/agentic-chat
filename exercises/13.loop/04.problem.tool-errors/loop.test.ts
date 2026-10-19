// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AgentTool, RunEventData, ToolCall } from "#learn/agent/types";

import { DEFAULT_CAPS } from "#learn/agent/caps";
import { approvalNeeded, decide, executeCall, giveUp, MAX_RETRIES, RunHalted } from "#learn/agent/loop";
import { drive, inMemoryRun } from "#learn/agent/loop-testing";
import { AGENT_INSTRUCTIONS } from "#learn/agent/prompt";
import { recordedRun, replayAgentModel, replayGuard, replayTools } from "@/core/agent/loop-recorded";

const viewer = { tenantId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };
const deps = { tools: [], viewer, runId: "run-1" };
const call: ToolCall = { callId: "c1", tool: "read_document", input: {} };
const tool = (execute: AgentTool["execute"]): AgentTool =>
  ({
    name: "read_document",
    description: "Read a document",
    input: z.object({}),
    effect: "read",
    needsApproval: () => false,
    execute,
  }) as AgentTool;

/** Fails the test instead of hanging when `executeCall` never settles. */
function within<T>(ms: number, promise: Promise<T>, why: string): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(why)), ms))]);
}

describe("executeCall", () => {
  it("runs the tool as the viewer, with a key that stays the same for the call", async () => {
    const execute = vi.fn(async () => ({ title: "KPC-2026-0142 Ashgrove MSA (executed).pdf" }));
    expect(await executeCall(call, tool(execute), { documentId: "x" }, deps)).toEqual({
      type: "tool_result",
      callId: "c1",
      ok: true,
      output: { title: "KPC-2026-0142 Ashgrove MSA (executed).pdf" },
    });
    expect(execute).toHaveBeenCalledWith(
      { documentId: "x" },
      expect.objectContaining({ viewer, runId: "run-1", callId: "c1", idempotencyKey: "agent:run-1:c1" }),
    );
  });

  it("answers null for a tool that returns nothing", async () => {
    const answer = await executeCall(
      call,
      tool(async () => undefined),
      {},
      deps,
    );
    expect(answer, "the output goes to the model as JSON, and undefined isn't JSON: null").toMatchObject({
      ok: true,
      output: null,
    });
  });

  it("turns a thrown error into a result the model can read", async () => {
    const failing = tool(async () => {
      throw new Error("No document 81a20785-70e1-494e-9a47-f352817e0ba2 that you can read.");
    });
    let answer: unknown;
    try {
      answer = await executeCall(call, failing, {}, deps);
    } catch (error) {
      expect.fail(`executeCall threw "${String(error)}": a tool's error goes back to the model as the call's result`);
    }
    expect(answer).toEqual({
      type: "tool_result",
      callId: "c1",
      ok: false,
      error: "No document 81a20785-70e1-494e-9a47-f352817e0ba2 that you can read.",
    });
  });

  it("gives up on a tool that never answers, even one that ignores its signal", async () => {
    const stuck = tool(() => new Promise(() => {}));
    const answer = await within(
      2000,
      executeCall(call, stuck, {}, { ...deps, timeoutMs: 20 }),
      "executeCall was still waiting 2 s after a 20 ms timeout: a tool that ignores its signal never settles, so " +
        "wait for whichever comes first, the tool or the abort",
    );
    expect(answer).toEqual({
      type: "tool_result",
      callId: "c1",
      ok: false,
      error: "read_document timed out after 0.02 s.",
    });
  });

  it("says it timed out when a tool that listens is aborted by the timeout", async () => {
    const listening = tool(
      (_input, ctx) =>
        new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason))),
    );
    expect(
      await executeCall(call, listening, {}, { ...deps, timeoutMs: 20 }),
      "the abort's own error isn't the news: the call timed out",
    ).toMatchObject({ ok: false, error: "read_document timed out after 0.02 s." });
  });

  it("lets RunHalted through: the kill switch stops the run, and the model never reads it", async () => {
    const halted = tool(async () => {
      throw new RunHalted("kill switch: incident 42");
    });
    let answer: unknown;
    try {
      answer = await executeCall(call, halted, {}, deps);
    } catch (error) {
      expect(error).toBeInstanceOf(RunHalted);
      return;
    }
    expect.fail(`executeCall answered ${JSON.stringify(answer)}: RunHalted must stop the run, not go to the model`);
  });

  it("throws the run's own abort: a cancelled run has nobody waiting for the result", async () => {
    const controller = new AbortController();
    const slow = tool(
      (_input, ctx) =>
        new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason))),
    );
    const pending = executeCall(call, slow, {}, { ...deps, signal: controller.signal });
    controller.abort(new Error("cancelled by the user"));
    const answer = await pending.then(
      (result) => result,
      (error: unknown) => error,
    );
    expect(answer, "a cancel isn't a tool failure for the model to read: throw the run's abort reason on").toEqual(
      new Error("cancelled by the user"),
    );
  });
});

describe("giveUp", () => {
  const error = (retryable: boolean, message = "503 from the provider"): RunEventData => ({
    type: "error",
    message,
    retryable,
  });

  it("carries on through retryable errors, and gives up at the third", () => {
    expect(MAX_RETRIES).toBe(3);
    expect(giveUp([]), "no errors: carry on").toBe(null);
    expect(giveUp([error(true), error(true)]), "two blips: ask the model again").toBe(null);
    expect(giveUp([error(true), error(true), error(true, "fetch failed")]), "the third in a row: give up").toEqual({
      kind: "finish",
      status: "failed",
      reason: "gave up after 3 errors: fetch failed",
    });
  });

  it("stops at once on an error that retrying can't fix", () => {
    expect(giveUp([error(false, "400: the request is too large")]), "retrying won't fix it: finish now").toEqual({
      kind: "finish",
      status: "failed",
      reason: "400: the request is too large",
    });
  });

  it("counts only the errors since the last model turn (decide passes those)", () => {
    const run = inMemoryRun();
    const usage = { inputTokens: 100, outputTokens: 10, reasoningTokens: 0 };
    run.append(
      { type: "user_message", messageId: "m", text: "go" },
      error(true),
      error(true),
      { type: "assistant_turn", text: "", toolCalls: [{ callId: "a", tool: "read_document", input: {} }], usage },
      { type: "tool_result", callId: "a", ok: true, output: null },
      error(true),
    );
    expect(decide(run.events, DEFAULT_CAPS, approvalNeeded([], viewer, "r"))).toEqual({ kind: "model" });
  });
});

describe("Grace's recorded run, with her first search hung", () => {
  it("feeds the timeout back; the model searches again with other words and answers", async () => {
    const recording = recordedRun("search-timeout");
    const hung = recording.tools.find((t) => t.tool === "search_documents")!.callId;
    const tools = replayTools("search-timeout").map((t) =>
      t.name === "search_documents"
        ? {
            ...t,
            // Hangs and ignores its signal, as the search did behind the rate limit.
            execute: (input: unknown, ctx: Parameters<AgentTool["execute"]>[1]) =>
              ctx.callId === hung ? new Promise(() => {}) : t.execute(input, ctx),
          }
        : t,
    );
    const { model, requests } = replayAgentModel("search-timeout");
    const run = inMemoryRun(recording.runId);
    run.append(recording.events[0].data);
    const last = await within(
      5000,
      drive(run, {
        model,
        tools,
        viewer: recording.viewer,
        instructions: AGENT_INSTRUCTIONS,
        guard: replayGuard("search-timeout"),
        toolTimeoutMs: 50,
      }),
      "the run was still going after 5 s: the hung search has to time out at 50 ms",
    );
    expect(last).toEqual({ kind: "finish", status: "succeeded" });
    const results = run.events.flatMap(({ data }) => (data.type === "tool_result" ? [data] : []));
    expect(results[1], "the hung search is a failed result for the model").toEqual({
      type: "tool_result",
      callId: hung,
      ok: false,
      error: "search_documents timed out after 0.05 s.",
    });
    expect(JSON.stringify(requests[2]), "the third request carries the timeout as the call's output").toContain(
      "search_documents timed out after 0.05 s.",
    );
    const retry = run.events[5].data;
    expect(retry.type === "assistant_turn" && retry.toolCalls[0].input).toEqual({
      query: "KPC-2026-0142 payment schedule invoicing due date",
      k: 5,
    });
    const answer = run.events.at(-2)!.data;
    expect(answer.type === "assistant_turn" && answer.text).toContain("£61,400 per month");
  });
});
