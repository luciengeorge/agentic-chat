import { describe, expect, it } from "vitest";

import type { RunEvent, RunEventData } from "./types";

import { capReached, DEFAULT_CAPS, runUsage, turnEstimate } from "./caps";
import { decide } from "./loop";
import { childCaps, childOutcome, delegateResult } from "./orchestrate";

const log = (...data: RunEventData[]): RunEvent[] =>
  data.map((d, i) => ({ runId: "r", seq: i + 1, at: "2026-10-14T12:00:00.000Z", data: d }));

const ask = (text = "go"): RunEventData => ({ type: "user_message", messageId: text, text });
const turn = (inputTokens: number, outputTokens: number, calls = 0): RunEventData => ({
  type: "assistant_turn",
  text: "",
  toolCalls: Array.from({ length: calls }, (_, i) => ({ callId: `c${inputTokens}-${i}`, tool: "t", input: {} })),
  usage: { inputTokens, outputTokens, reasoningTokens: 0 },
});

describe("the per-run token cap", () => {
  it("counts each turn's new input and its output, not the whole context again", () => {
    // A context that grows by 2,000 tokens a turn: 10k, 12k, 14k, 16k, 18k of input.
    const events = log(ask(), ...[10_000, 12_000, 14_000, 16_000, 18_000].map((input) => turn(input, 500)));
    expect(runUsage(events).tokens).toBe(18_000 + 5 * 500);
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
    expect(runUsage(events).tokens).toBe(30_000 + 2_000 + 4 * 500);
  });

  it("lets a long run that compacts keep going under the 60,000 cap", () => {
    // Twelve turns, compacting back to 8k whenever the context passes 24k. Summed input would be ~200k.
    const data: RunEventData[] = [ask()];
    let input = 8_000;
    for (let i = 0; i < 11; i++) {
      data.push(turn(input, 300));
      input = input >= 24_000 ? 8_000 : input + 4_000;
    }
    const events = log(...data);
    expect(capReached(runUsage(events), DEFAULT_CAPS)).toBeNull();
  });
});

describe("a parent's caps count what its children spent", () => {
  const child = (tokens: number, toolCalls: number) =>
    log(ask("task"), turn(tokens, 0, toolCalls), { type: "status", from: "running", to: "succeeded" });

  it("records the child's spend on the delegate result, and the parent's usage adds it", () => {
    const outcome = childOutcome(child(25_000, 0));
    expect(outcome.usage).toEqual({ tokens: 25_000, toolCalls: 0 });
    const result = delegateResult("d1", "child-1", outcome);
    expect(result.usage).toEqual({ tokens: 25_000, toolCalls: 0 });

    const parent = log(ask(), turn(2_000, 100, 1), { ...result, callId: "c2000-0" });
    expect(runUsage(parent)).toMatchObject({ tokens: 2_100 + 25_000, toolCalls: 1 });
  });

  it("stops a parent whose children spent its tokens, though its own turns were cheap", () => {
    const spent = delegateResult("c2000-0", "k", childOutcome(child(30_000, 0)));
    const spent2 = delegateResult("c2000-1", "k2", childOutcome(child(30_000, 0)));
    const parent = log(ask(), turn(2_000, 100, 2), spent, spent2);
    expect(decide(parent, DEFAULT_CAPS, () => false)).toMatchObject({
      kind: "finish",
      status: "failed",
      reason: "cap reached: 60000 tokens",
    });
  });

  it("gives the next turn's children only what the parent has left", () => {
    const used = { tokens: 50_000, toolCalls: 10 };
    expect(childCaps(DEFAULT_CAPS, 2, used)).toEqual({ ...DEFAULT_CAPS, tokens: 5_000, toolCalls: 9 });
    expect(childCaps(DEFAULT_CAPS, 2, { tokens: 70_000, toolCalls: 30 })).toEqual({
      ...DEFAULT_CAPS,
      tokens: 0,
      toolCalls: 0,
    });
  });

  it("bounds a parent and all its children by the parent's caps", () => {
    // A parent delegating to two children every turn, each child spending all it's given: the total stays under
    // the parent's cap plus its own turns, never 12 x 60k.
    const data: RunEventData[] = [ask()];
    let total = 0;
    for (let t = 0; t < DEFAULT_CAPS.modelTurns; t++) {
      const events = log(...data);
      const next = decide(events, DEFAULT_CAPS, () => false);
      if (next.kind !== "model" && next.kind !== "tools") break;
      data.push(turn(1_000 * (t + 1), 100, 2));
      total += 1_100;
      const caps = childCaps(DEFAULT_CAPS, 2, runUsage(log(...data)));
      for (let i = 0; i < 2; i++) {
        const spentByChild = caps.tokens;
        total += spentByChild;
        const kid = log(ask("t"), turn(spentByChild, 0), { type: "status", from: "running", to: "succeeded" });
        data.push(delegateResult(`c${1_000 * (t + 1)}-${i}`, "k", childOutcome(kid)));
      }
    }
    expect(total).toBeLessThanOrEqual(DEFAULT_CAPS.tokens + 2_200);
  });
});

describe("a model call's estimate", () => {
  it("is the request's tokens plus the most it may write", () => {
    const small = turnEstimate({ instructions: "be brief", messages: [{ role: "user", content: "hi" }] });
    const capped = turnEstimate({
      instructions: "be brief",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 100,
    });
    expect(capped).toBeGreaterThan(100);
    expect(capped).toBeLessThan(150);
    expect(small - capped).toBe(4_000 - 100);
  });
});
