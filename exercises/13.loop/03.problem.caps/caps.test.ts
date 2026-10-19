// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { RunEvent, RunEventData } from "#learn/agent/types";

import { type Caps, capReached, DEFAULT_CAPS, runUsage } from "#learn/agent/caps";
import { drive, inMemoryRun } from "#learn/agent/loop-testing";
import { AGENT_INSTRUCTIONS } from "#learn/agent/prompt";
import { recordedRun, replayAgentModel, replayGuard, replayTools } from "@/core/agent/loop-recorded";

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, reasoningTokens: 0 });
const ask = (text = "go"): RunEventData => ({ type: "user_message", messageId: text, text });
const turn = (input: number, output: number, calls = 0): RunEventData => ({
  type: "assistant_turn",
  text: "",
  toolCalls: Array.from({ length: calls }, (_, i) => ({
    callId: `c${input}-${i}`,
    tool: "search_documents",
    input: {},
  })),
  usage: usage(input, output),
});
const result = (callId: string, child?: { tokens: number; toolCalls: number }): RunEventData => ({
  type: "tool_result",
  callId,
  ok: true,
  output: null,
  ...(child ? { usage: child } : {}),
});

/** Events a second apart, from 09:00:00. */
const log = (...data: RunEventData[]): RunEvent[] =>
  data.map((d, i) => ({
    runId: "r",
    seq: i + 1,
    at: new Date(Date.parse("2026-10-19T09:00:00Z") + i * 1000).toISOString(),
    data: d,
  }));

describe("runUsage", () => {
  it("counts model turns, and tool calls once they have a result", () => {
    const events = log(ask(), turn(1000, 50, 3), result("c1000-0"), result("c1000-1"));
    expect(runUsage(events).modelTurns).toBe(1);
    expect(runUsage(events).toolCalls, "3 calls asked for, 2 with a result: a call counts once it ran").toBe(2);
  });

  it("counts each turn's new input and its output, never the whole context again", () => {
    // A context that grows by 2,000 tokens a turn: 10k, 12k, 14k, 16k, 18k of input.
    const events = log(ask(), ...[10_000, 12_000, 14_000, 16_000, 18_000].map((input) => turn(input, 500)));
    expect(
      runUsage(events).tokens,
      "18,000 of input in all (each turn repeats the last) plus 5 x 500 of output; summing every input gives 70,000",
    ).toBe(18_000 + 5 * 500);
  });

  it("counts nothing for a compacted context, then only what grows after it", () => {
    const events = log(
      ask(),
      turn(20_000, 500),
      turn(30_000, 500),
      { type: "compaction", throughSeq: 3, summary: "s" },
      turn(6_000, 500),
      turn(8_000, 500),
    );
    expect(runUsage(events).tokens, "the drop to 6,000 adds nothing (never below 0), then 2,000 more").toBe(
      30_000 + 2_000 + 4 * 500,
    );
  });

  it("adds what a sub-agent spent, from its delegate call's result", () => {
    const events = log(ask(), turn(1000, 100, 1), result("c1000-0", { tokens: 25_000, toolCalls: 4 }));
    expect(
      runUsage(events),
      "the result's usage is what the sub-agent spent: its 25,000 tokens and 4 calls count against this run",
    ).toMatchObject({ tokens: 1100 + 25_000, toolCalls: 1 + 4 });
  });

  it("counts active time while running, never while waiting", () => {
    const at = (iso: string, data: RunEventData): RunEvent => ({ runId: "r", seq: 1, at: iso, data });
    const events = [
      at("2026-10-19T09:00:00Z", { type: "status", from: "queued", to: "running" }),
      at("2026-10-19T09:00:00Z", ask()),
      at("2026-10-19T09:00:30Z", turn(1000, 10, 1)),
      at("2026-10-19T09:01:00Z", { type: "status", from: "running", to: "waiting" }),
      at("2026-10-20T09:00:00Z", { type: "status", from: "waiting", to: "running" }),
      at("2026-10-20T09:00:20Z", ask("approved")),
    ];
    expect(runUsage(events).activeMs, "60 s running, a day waiting (not counted), then 20 s running").toBe(80_000);
  });

  it("counts a log with no status yet as running from its first event", () => {
    expect(runUsage(log(ask(), turn(100, 10), turn(200, 10))).activeMs).toBe(2000);
  });
});

describe("capReached", () => {
  const used = (u: Partial<ReturnType<typeof runUsage>>) => ({
    modelTurns: 0,
    toolCalls: 0,
    tokens: 0,
    activeMs: 0,
    ...u,
  });

  it("has room until a cap is reached", () => {
    expect(capReached(used({ modelTurns: 11, toolCalls: 29, tokens: 59_999, activeMs: 599_999 }), DEFAULT_CAPS)).toBe(
      null,
    );
  });

  it("stops before a model turn at each cap, naming it", () => {
    expect(capReached(used({ modelTurns: 12 }), DEFAULT_CAPS)).toBe("cap reached: 12 model turns");
    expect(capReached(used({ tokens: 60_000 }), DEFAULT_CAPS), "at the cap is reached, not under it").toBe(
      "cap reached: 60000 tokens",
    );
    expect(capReached(used({ activeMs: 600_000 }), DEFAULT_CAPS)).toBe("cap reached: 600 s of active time");
  });

  it("names the first cap reached, in order: time, tokens, turns", () => {
    const all = used({ modelTurns: 12, tokens: 60_000, activeMs: 600_000 });
    expect(capReached(all, DEFAULT_CAPS)).toBe("cap reached: 600 s of active time");
    expect(capReached({ ...all, activeMs: 0 }, DEFAULT_CAPS)).toBe("cap reached: 60000 tokens");
  });

  it("counts a batch of calls in before it runs", () => {
    expect(
      capReached(used({ toolCalls: 28 }), DEFAULT_CAPS, 3),
      "28 made and 3 waiting would make 31: refuse the batch before it runs",
    ).toBe("cap reached: 30 tool calls");
    expect(capReached(used({ toolCalls: 28 }), DEFAULT_CAPS, 2), "28 and 2 is exactly 30: room").toBe(null);
    expect(capReached(used({ toolCalls: 28, tokens: 60_000 }), DEFAULT_CAPS, 1), "tokens stop a batch too").toBe(
      "cap reached: 60000 tokens",
    );
  });

  it("lets the last turn's calls run: the turn cap is checked before a turn", () => {
    expect(capReached(used({ modelTurns: 12 }), DEFAULT_CAPS, 2), "the 12th turn's calls still run").toBe(null);
  });
});

describe("Grace's recorded run, under caps", () => {
  async function replay(caps: Caps) {
    const recording = recordedRun("kpc-terms");
    const run = inMemoryRun(recording.runId);
    run.append(recording.events[0].data);
    const last = await drive(run, {
      model: replayAgentModel("kpc-terms").model,
      tools: replayTools("kpc-terms"),
      viewer: recording.viewer,
      instructions: AGENT_INSTRUCTIONS,
      guard: replayGuard("kpc-terms"),
      approve: () => "approved",
      caps,
    });
    const mailed = run.events.some(
      ({ data }) => data.type === "tool_result" && data.ok && (data.output as { sent?: boolean })?.sent === true,
    );
    return { last, events: run.events, mailed };
  }

  it("uses 5 turns, 5 tool calls and 7,257 tokens: the last context plus what the turns wrote", () => {
    expect(runUsage(recordedRun("kpc-terms").events)).toEqual({
      modelTurns: 5,
      toolCalls: 5,
      tokens: 7257,
      activeMs: 13_000,
    });
  });

  it("finishes under a 10,000-token cap, and stops before the mail goes under 7,000", async () => {
    const roomy = await replay({ ...DEFAULT_CAPS, tokens: 10_000 });
    expect(roomy.last, "7,257 is under 10,000 (summing every turn's input would reach 14,934 before the mail)").toEqual(
      {
        kind: "finish",
        status: "succeeded",
      },
    );
    expect(roomy.mailed).toBe(true);

    const tight = await replay({ ...DEFAULT_CAPS, tokens: 7_000 });
    expect(tight.last, "after four turns the run has used 7,011: the approved mail's batch is refused").toEqual({
      kind: "finish",
      status: "failed",
      reason: "cap reached: 7000 tokens",
    });
    expect(tight.mailed, "the cap is checked before the batch, so nothing was sent").toBe(false);
  });
});
