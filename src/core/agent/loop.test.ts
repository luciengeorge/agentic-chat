// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { scriptedTurns } from "#learn/model/testing";

import type { AgentTool, RunEventData, ToolCall } from "./types";

import { type Caps, DEFAULT_CAPS, runUsage } from "./caps";
import {
  approvalNeeded,
  decide,
  declinedResult,
  idempotencyKey,
  modelTurn,
  type RunGuard,
  RunHalted,
  runTool,
  runTools,
  toolSpecs,
} from "./loop";
import { drive, inMemoryRun } from "./loop-testing";

const viewer = { tenantId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };
const usage = { inputTokens: 100, outputTokens: 10, reasoningTokens: 0 };

const echo: AgentTool<{ text: string }, { echoed: string }> = {
  name: "echo",
  description: "Echo the text",
  input: z.object({ text: z.string().min(1) }),
  effect: "read",
  needsApproval: () => false,
  execute: async ({ text }) => ({ echoed: text }),
};
const send: AgentTool<{ to: string }, { sent: true }> = {
  name: "send",
  description: "Send something",
  input: z.object({ to: z.string() }),
  effect: "write",
  needsApproval: () => true,
  execute: async () => ({ sent: true }),
};
const TOOLS = [echo, send] as AgentTool[];
const needsApproval = approvalNeeded(TOOLS, viewer, "run-1");

const call = (callId: string, tool = "echo", input: unknown = { text: callId }): ToolCall => ({ callId, tool, input });
const turn = (...toolCalls: ToolCall[]): RunEventData => ({ type: "assistant_turn", text: "", toolCalls, usage });
const ask = (text = "hi"): RunEventData => ({ type: "user_message", messageId: text, text });
const result = (callId: string): RunEventData => ({ type: "tool_result", callId, ok: true, output: null });

function log(...data: RunEventData[]) {
  const run = inMemoryRun();
  run.append(...data);
  return run.events;
}

describe("decide", () => {
  const next = (...data: RunEventData[]) => decide(log(...data), DEFAULT_CAPS, needsApproval);

  it("waits for a message, then asks the model", () => {
    expect(next()).toEqual({ kind: "wait" });
    expect(next(ask())).toEqual({ kind: "model" });
  });

  it("runs the turn's calls that need no approval together, then goes back to the model", () => {
    expect(next(ask(), turn(call("a"), call("b")))).toEqual({ kind: "tools", calls: [call("a"), call("b")] });
    expect(next(ask(), turn(call("a"), call("b")), result("a"))).toEqual({ kind: "tools", calls: [call("b")] });
    expect(next(ask(), turn(call("a"), call("b")), result("a"), result("b"))).toEqual({ kind: "model" });
  });

  it("asks for approval of a write after the reads run, waits for the decision, then runs it", () => {
    const write = call("w", "send", { to: "tom" });
    expect(next(ask(), turn(write, call("a")))).toEqual({ kind: "tools", calls: [call("a")] });
    expect(next(ask(), turn(write, call("a")), result("a"))).toEqual({ kind: "approval", call: write });
    const asked: RunEventData = { type: "approval_requested", approvalId: "ap", call: write, expiresAt: "x" };
    expect(next(ask(), turn(write), asked)).toEqual({ kind: "wait" });
    const approved: RunEventData = { type: "approval_decided", approvalId: "ap", decision: "approved", by: "u" };
    expect(next(ask(), turn(write), asked, approved)).toEqual({ kind: "tools", calls: [write] });
    expect(next(ask(), turn(write), asked, approved, result("w"))).toEqual({ kind: "model" });
  });

  it("goes back to the model after a rejection, with the rejection as the call's result", () => {
    const write = call("w", "send", { to: "tom" });
    const asked: RunEventData = { type: "approval_requested", approvalId: "ap", call: write, expiresAt: "x" };
    const rejected: RunEventData = { type: "approval_decided", approvalId: "ap", decision: "rejected", by: "u" };
    expect(next(ask(), turn(write), asked, rejected, declinedResult("w", "rejected"))).toEqual({ kind: "model" });
  });

  it("asks for approvals one at a time", () => {
    const [w1, w2] = [call("w1", "send", { to: "a" }), call("w2", "send", { to: "b" })];
    const asked: RunEventData = { type: "approval_requested", approvalId: "ap1", call: w1, expiresAt: "x" };
    expect(next(ask(), turn(w1, w2))).toEqual({ kind: "approval", call: w1 });
    expect(next(ask(), turn(w1, w2), asked)).toEqual({ kind: "approval", call: w2 });
  });

  it("needs no approval for a write whose input is invalid: runTool refuses it", () => {
    const bad = call("w", "send", { to: 3 });
    expect(next(ask(), turn(bad))).toEqual({ kind: "tools", calls: [bad] });
  });

  it("finishes when the last turn makes no calls, unless a newer message came in", () => {
    expect(next(ask(), turn())).toEqual({ kind: "finish", status: "succeeded" });
    expect(next(ask(), turn(), ask("more"))).toEqual({ kind: "model" });
  });

  it("does nothing for a finished run", () => {
    expect(next(ask(), { type: "status", from: "running", to: "failed" }, ask())).toEqual({ kind: "wait" });
  });

  it("retries a retryable error, gives up after three, and stops on one that isn't", () => {
    const error = (retryable: boolean): RunEventData => ({ type: "error", message: "boom", retryable });
    expect(next(ask(), error(true), error(true))).toEqual({ kind: "model" });
    expect(next(ask(), error(true), error(true), error(true))).toMatchObject({ kind: "finish", status: "failed" });
    expect(next(ask(), error(false))).toEqual({ kind: "finish", status: "failed", reason: "boom" });
  });
});

describe("caps", () => {
  const caps = (overrides: Partial<Caps>): Caps => ({ ...DEFAULT_CAPS, ...overrides });

  it("stops before a model turn past the turn cap", () => {
    const events = log(ask(), turn(call("a")), result("a"), turn(call("b")), result("b"));
    expect(decide(events, caps({ modelTurns: 2 }), needsApproval)).toEqual({
      kind: "finish",
      status: "failed",
      reason: "cap reached: 2 model turns",
    });
  });

  it("stops before calls that would pass the tool call cap", () => {
    const events = log(ask(), turn(call("a")), result("a"), turn(call("b"), call("c")));
    expect(decide(events, caps({ toolCalls: 2 }), needsApproval)).toMatchObject({
      kind: "finish",
      reason: "cap reached: 2 tool calls",
    });
    expect(decide(events, caps({ toolCalls: 3 }), needsApproval)).toMatchObject({ kind: "tools" });
  });

  it("stops past the token cap", () => {
    const events = log(ask(), turn(call("a")), result("a"));
    expect(decide(events, caps({ tokens: 110 }), needsApproval)).toMatchObject({
      kind: "finish",
      reason: "cap reached: 110 tokens",
    });
  });

  it("counts active time, not time spent waiting", () => {
    const run = inMemoryRun();
    const at = (iso: string, data: RunEventData) =>
      run.events.push({ runId: "r", seq: run.events.length + 1, at: iso, data });
    at("2026-10-14T09:00:00Z", { type: "status", from: "queued", to: "running" });
    at("2026-10-14T09:00:00Z", ask());
    at("2026-10-14T09:00:30Z", turn());
    at("2026-10-14T09:01:00Z", { type: "status", from: "running", to: "waiting" });
    at("2026-10-15T09:00:00Z", { type: "status", from: "waiting", to: "running" });
    at("2026-10-15T09:00:20Z", ask("again"));
    expect(runUsage(run.events).activeMs).toBe(80_000);
    expect(decide(run.events, caps({ activeMs: 90_000 }), needsApproval)).toEqual({ kind: "model" });
    expect(decide(run.events, caps({ activeMs: 80_000 }), needsApproval)).toMatchObject({
      kind: "finish",
      status: "failed",
      reason: "cap reached: 80 s of active time",
    });
  });
});

describe("modelTurn", () => {
  it("sends the tools as JSON Schema and returns the turn: text, calls and usage", async () => {
    const { model, mock } = scriptedTurns([
      { text: "Let me look.", toolCalls: [{ callId: "c1", name: "echo", input: { text: "x" } }], inputTokens: 50 },
    ]);
    const deltas: string[] = [];
    const turnEvent = await modelTurn(
      { instructions: "Be useful.", messages: [{ role: "user", content: "hi" }] },
      { model, tools: TOOLS, reasoningEffort: "low", onTextDelta: (d) => deltas.push(d) },
    );
    expect(turnEvent).toEqual({
      type: "assistant_turn",
      text: "Let me look.",
      toolCalls: [{ callId: "c1", tool: "echo", input: { text: "x" } }],
      usage: { inputTokens: 50, outputTokens: 10, reasoningTokens: 0 },
    });
    expect(deltas.join("")).toBe("Let me look.");
    expect(mock.doStreamCalls[0].tools?.map((t) => t.name)).toEqual(["echo", "send"]);
    expect(toolSpecs([echo as AgentTool])[0].inputSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string", minLength: 1 } },
      required: ["text"],
    });
  });

  it("checks the guard before the call and charges it after", async () => {
    const { model, mock } = scriptedTurns([{ text: "ok" }]);
    const guard: RunGuard = {
      beforeModelTurn: vi.fn(async () => {}),
      afterModelTurn: vi.fn(async () => {}),
      beforeToolCall: vi.fn(async () => {}),
    };
    await modelTurn(
      { instructions: "", messages: [{ role: "user", content: "hi" }] },
      { model, tools: [], reasoningEffort: "low", guard },
    );
    expect(guard.beforeModelTurn).toHaveBeenCalledOnce();
    expect(guard.afterModelTurn).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 10, reasoningTokens: 0 });

    const stop: RunGuard = { ...guard, beforeModelTurn: async () => Promise.reject(new RunHalted("kill switch: on")) };
    await expect(
      modelTurn({ instructions: "", messages: [] }, { model, tools: [], reasoningEffort: "low", guard: stop }),
    ).rejects.toThrow("kill switch: on");
    expect(mock.doStreamCalls).toHaveLength(1);
  });
});

describe("runTool", () => {
  const deps = { tools: TOOLS, viewer, runId: "run-1" };

  it("runs the tool as the viewer with a stable idempotency key", async () => {
    const execute = vi.fn(async () => ({ ok: 1 }));
    const tool = { ...echo, execute } as AgentTool;
    expect(await runTool(call("c1"), { ...deps, tools: [tool] })).toEqual({
      type: "tool_result",
      callId: "c1",
      ok: true,
      output: { ok: 1 },
    });
    expect(execute).toHaveBeenCalledWith(
      { text: "c1" },
      expect.objectContaining({ viewer, runId: "run-1", callId: "c1", idempotencyKey: "agent:run-1:c1" }),
    );
    expect(idempotencyKey("run-1", "c1")).toBe(idempotencyKey("run-1", "c1"));
  });

  it("returns an unknown tool, invalid input and a thrown error as ok: false", async () => {
    expect(await runTool(call("c", "nope"), deps)).toMatchObject({ ok: false, error: "There is no tool called nope." });
    expect(await runTool(call("c", "echo", { text: "" }), deps)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Invalid input"),
    });
    const failing = { ...echo, execute: async () => Promise.reject(new Error("drive offline")) } as AgentTool;
    expect(await runTool(call("c"), { ...deps, tools: [failing] })).toMatchObject({
      ok: false,
      error: "drive offline",
    });
  });

  it("times out a tool that never answers, even one that ignores its signal", async () => {
    const stuck = { ...echo, execute: () => new Promise(() => {}) } as AgentTool;
    expect(await runTool(call("c"), { ...deps, tools: [stuck], timeoutMs: 20 })).toEqual({
      type: "tool_result",
      callId: "c",
      ok: false,
      error: "echo timed out after 0.02 s.",
    });
  });

  it("lets RunHalted through: the kill switch stops the run, the model never sees it", async () => {
    const execute = vi.fn();
    const guard: RunGuard = {
      beforeModelTurn: async () => {},
      afterModelTurn: async () => {},
      beforeToolCall: async () => Promise.reject(new RunHalted("kill switch: on")),
    };
    await expect(runTool(call("c"), { ...deps, tools: [{ ...echo, execute } as AgentTool], guard })).rejects.toThrow(
      RunHalted,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("runs a turn's calls in parallel and returns the results in call order", async () => {
    const finished: string[] = [];
    const slow = {
      ...echo,
      execute: async ({ text }: { text: string }) => {
        await new Promise((resolve) => setTimeout(resolve, text === "first" ? 60 : 10));
        finished.push(text);
        return { echoed: text };
      },
    } as AgentTool;
    const started = Date.now();
    const results = await runTools([call("1", "echo", { text: "first" }), call("2", "echo", { text: "second" })], {
      ...deps,
      tools: [slow],
    });
    expect(Date.now() - started).toBeLessThan(65 + 40);
    expect(finished).toEqual(["second", "first"]);
    expect(results.map((r) => r.callId)).toEqual(["1", "2"]);
  });
});

describe("the loop, scripted", () => {
  it("feeds a tool error back and recovers from it", async () => {
    const { model, mock } = scriptedTurns([
      { toolCalls: [{ callId: "c1", name: "echo", input: { text: "" } }] },
      { toolCalls: [{ callId: "c2", name: "echo", input: { text: "hello" } }] },
      { text: "It said hello." },
    ]);
    const run = inMemoryRun();
    run.append(ask("echo hello"));
    expect(await drive(run, { model, tools: TOOLS, viewer })).toEqual({ kind: "finish", status: "succeeded" });
    const results = run.events.flatMap((e) => (e.data.type === "tool_result" ? [e.data] : []));
    expect(results).toMatchObject([
      { callId: "c1", ok: false },
      { callId: "c2", ok: true, output: { echoed: "hello" } },
    ]);
    // The second turn saw the first call's error.
    const second = mock.doStreamCalls[1].prompt;
    expect(second.at(-1)).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c1", output: { type: "error-text" } }],
    });
  });

  it("stops at a write's approval, and runs it once approved", async () => {
    const script = () =>
      scriptedTurns([{ toolCalls: [{ callId: "w", name: "send", input: { to: "tom" } }] }, { text: "Sent." }]);
    const paused = inMemoryRun();
    paused.append(ask("send it"));
    const stop = await drive(paused, { model: script().model, tools: TOOLS, viewer });
    expect(stop).toEqual({ kind: "approval", call: call("w", "send", { to: "tom" }) });

    const approved = inMemoryRun();
    approved.append(ask("send it"));
    const end = await drive(approved, { model: script().model, tools: TOOLS, viewer, approve: () => "approved" });
    expect(end).toEqual({ kind: "finish", status: "succeeded" });
    expect(approved.events.find((e) => e.data.type === "tool_result")?.data).toMatchObject({ ok: true });
  });

  it("finishes failed with the reason when the model turn cap trips", async () => {
    const { model } = scriptedTurns(
      Array.from({ length: 3 }, (_, i) => ({ toolCalls: [{ callId: `c${i}`, name: "echo", input: { text: "x" } }] })),
    );
    const run = inMemoryRun();
    run.append(ask());
    expect(await drive(run, { model, tools: TOOLS, viewer, caps: { ...DEFAULT_CAPS, modelTurns: 2 } })).toEqual({
      kind: "finish",
      status: "failed",
      reason: "cap reached: 2 model turns",
    });
    expect(run.events.at(-1)?.data).toMatchObject({ type: "status", to: "failed" });
  });

  it("finishes failed when the kill switch is on before a tool call", async () => {
    const { model } = scriptedTurns([{ toolCalls: [{ callId: "c", name: "echo", input: { text: "x" } }] }]);
    let killed = false;
    const guard: RunGuard = {
      beforeModelTurn: async () => {},
      afterModelTurn: async () => {
        killed = true;
      },
      beforeToolCall: async () => {
        if (killed) throw new RunHalted("kill switch: incident");
      },
    };
    const run = inMemoryRun();
    run.append(ask());
    expect(await drive(run, { model, tools: TOOLS, viewer, guard })).toEqual({
      kind: "finish",
      status: "failed",
      reason: "kill switch: incident",
    });
    expect(run.events.some((e) => e.data.type === "tool_result")).toBe(false);
  });
});
