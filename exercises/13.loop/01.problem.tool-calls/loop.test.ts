// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AgentTool, RunEventData, ToolCall } from "#learn/agent/types";
import type { ChatEvent } from "#learn/model/types";

import { DEFAULT_CAPS } from "#learn/agent/caps";
import { approvalNeeded, decide, readTurn } from "#learn/agent/loop";
import { drive, inMemoryRun } from "#learn/agent/loop-testing";
import { AGENT_INSTRUCTIONS } from "#learn/agent/prompt";
import { recordedRun, replayAgentModel, replayGuard, replayTools } from "@/core/agent/loop-recorded";

const viewer = { tenantId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };
const usage = { inputTokens: 1949, outputTokens: 64, reasoningTokens: 0 };

async function* stream(...events: ChatEvent[]): AsyncGenerator<ChatEvent> {
  for (const event of events) yield event;
}

describe("readTurn", () => {
  it("joins the text, hands each delta on as it comes, and keeps each call whole with its id", async () => {
    const deltas: string[] = [];
    const turn = await readTurn(
      stream(
        { type: "text-delta", delta: "Let me find " },
        { type: "text-delta", delta: "the contract." },
        {
          type: "tool-call",
          callId: "call_O9Lr1ruoMAPvNh97zyCLPLlB",
          name: "search_documents",
          input: { query: "contract KPC-2026-0142 payment terms", k: 5 },
        },
        { type: "tool-call", callId: "call_ghhLwhqQndUvaJtVex0VFDTh", name: "find_person", input: { query: "Tom" } },
        { type: "finish", finishReason: "tool-calls", usage },
      ),
      (delta) => deltas.push(delta),
    );
    expect(turn.text, "the text is every delta, joined in order").toBe("Let me find the contract.");
    expect(deltas, "each delta goes to onTextDelta as it arrives").toEqual(["Let me find ", "the contract."]);
    expect(turn.toolCalls, "each call keeps its callId, its tool (the event's name) and its input").toEqual([
      {
        callId: "call_O9Lr1ruoMAPvNh97zyCLPLlB",
        tool: "search_documents",
        input: { query: "contract KPC-2026-0142 payment terms", k: 5 },
      },
      { callId: "call_ghhLwhqQndUvaJtVex0VFDTh", tool: "find_person", input: { query: "Tom" } },
    ]);
    expect(turn).toEqual({ type: "assistant_turn", text: turn.text, toolCalls: turn.toolCalls, usage });
  });

  it("reads a turn with no onTextDelta to call", async () => {
    const turn = await readTurn(
      stream({ type: "text-delta", delta: "Done." }, { type: "finish", finishReason: "stop", usage }),
    );
    expect(turn).toEqual({ type: "assistant_turn", text: "Done.", toolCalls: [], usage });
  });

  it("throws when the stream ends without a finish: a turn with no usage is broken", async () => {
    let turn: unknown;
    try {
      turn = await readTurn(stream({ type: "text-delta", delta: "Let me look" }));
    } catch {
      return;
    }
    expect.fail(`the stream had no finish, so there's no usage to charge; readTurn returned ${JSON.stringify(turn)}`);
  });
});

describe("decide", () => {
  const echo: AgentTool<{ text: string }, { echoed: string }> = {
    name: "echo",
    description: "Echo the text",
    input: z.object({ text: z.string() }),
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
  const gate = approvalNeeded([echo, send] as AgentTool[], viewer, "run-1");

  const call = (callId: string, tool = "echo", input: unknown = { text: callId }): ToolCall => ({
    callId,
    tool,
    input,
  });
  const turn = (...toolCalls: ToolCall[]): RunEventData => ({ type: "assistant_turn", text: "", toolCalls, usage });
  const ask = (text = "hi"): RunEventData => ({ type: "user_message", messageId: text, text });
  const result = (callId: string): RunEventData => ({ type: "tool_result", callId, ok: true, output: null });
  const next = (...data: RunEventData[]) => {
    const run = inMemoryRun();
    run.append(...data);
    return decide(run.events, DEFAULT_CAPS, gate);
  };

  it("waits for a message, then gives the model its turn", () => {
    expect(next(), "an empty run has nothing to answer").toEqual({ kind: "wait" });
    expect(next(ask()), "a user message waiting is the model's turn").toEqual({ kind: "model" });
  });

  it("runs the turn's calls together, then gives the model its turn once every result is in", () => {
    expect(next(ask(), turn(call("a"), call("b")))).toEqual({ kind: "tools", calls: [call("a"), call("b")] });
    expect(
      next(ask(), turn(call("a"), call("b")), result("a"), result("b")),
      "every call has its result: the model's turn to read them (finishing here answers nobody)",
    ).toEqual({ kind: "model" });
  });

  it("runs only the calls that have no result yet", () => {
    expect(next(ask(), turn(call("a"), call("b")), result("a")), "a already has its result").toEqual({
      kind: "tools",
      calls: [call("b")],
    });
  });

  it("asks for a write's approval after the reads, waits for the decision, then runs it", () => {
    const write = call("w", "send", { to: "tom" });
    expect(next(ask(), turn(write, call("a"))), "the read runs first").toEqual({ kind: "tools", calls: [call("a")] });
    expect(next(ask(), turn(write, call("a")), result("a"))).toEqual({ kind: "approval", call: write });
    const asked: RunEventData = { type: "approval_requested", approvalId: "ap", call: write, expiresAt: "x" };
    expect(next(ask(), turn(write), asked), "the user hasn't decided yet").toEqual({ kind: "wait" });
    const approved: RunEventData = { type: "approval_decided", approvalId: "ap", decision: "approved", by: "u" };
    expect(next(ask(), turn(write), asked, approved)).toEqual({ kind: "tools", calls: [write] });
  });

  it("finishes when the last turn made no calls", () => {
    expect(next(ask(), turn()), "a turn of words alone is the answer").toEqual({
      kind: "finish",
      status: "succeeded",
    });
  });

  it("gives the model a turn when the user wrote after the last turn", () => {
    expect(next(ask(), turn(), ask("and Mia too")), "a message newer than the answer still needs one").toEqual({
      kind: "model",
    });
  });

  it("goes by the last turn, not the first", () => {
    expect(next(ask(), turn(call("a")), result("a"), turn()), "the last turn made no calls").toEqual({
      kind: "finish",
      status: "succeeded",
    });
    expect(next(ask(), turn(), ask("more"), turn(call("b"))), "the last turn's call is b").toEqual({
      kind: "tools",
      calls: [call("b")],
    });
  });

  it("does nothing more for a finished run, even when a message comes in", () => {
    const failed: RunEventData = { type: "status", from: "running", to: "failed", reason: "cap reached" };
    expect(next(ask(), failed, ask("hello?")), "the run's last status is final").toEqual({ kind: "wait" });
    expect(next(ask(), turn(call("a")), { type: "status", from: "running", to: "cancelled" })).toEqual({
      kind: "wait",
    });
  });
});

describe("Grace's recorded run, through your loop", () => {
  it("emails Tom KPC-2026-0142's payment terms in 5 model turns and 14 events", async () => {
    const recording = recordedRun("kpc-terms");
    const { model, requests } = replayAgentModel("kpc-terms");
    const run = inMemoryRun(recording.runId);
    run.append(recording.events[0].data);
    const last = await drive(run, {
      model,
      tools: replayTools("kpc-terms"),
      viewer: recording.viewer,
      instructions: AGENT_INSTRUCTIONS,
      guard: replayGuard("kpc-terms"),
      approve: () => "approved",
    });
    expect(last).toEqual({ kind: "finish", status: "succeeded" });
    expect(requests, "five model turns: plan, search and find, read, mail, answer").toHaveLength(5);
    const kinds = run.events.map(({ data }) =>
      data.type === "assistant_turn" ? `turn(${data.toolCalls.map((c) => c.tool).join(", ")})` : data.type,
    );
    expect(kinds).toEqual([
      "user_message",
      "turn(make_plan)",
      "tool_result",
      "turn(search_documents, find_person)",
      "tool_result",
      "tool_result",
      "turn(read_document)",
      "tool_result",
      "turn(send_mail)",
      "approval_requested",
      "approval_decided",
      "tool_result",
      "turn()",
      "status",
    ]);
    expect(run.events.map((e) => e.data)).toEqual(recording.events.map((e) => e.data));
    const answer = run.events.at(-2)!.data;
    expect(answer.type === "assistant_turn" && answer.text).toBe(
      "Emailed Tom Whitfield the two-line summary of the payment terms in KPC-2026-0142.",
    );
  });
});
