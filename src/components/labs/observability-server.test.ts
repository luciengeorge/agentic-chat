// @vitest-environment node
import { describe, expect, it } from "vitest";

import { observabilityLab, priceTurn, recordedTurnUsage } from "./observability-server";

describe("the observability lab", () => {
  it("reads each recorded turn's usage as OpenAI reported it", () => {
    expect(recordedTurnUsage("brightwell")).toEqual({ inputTokens: 1776, cachedInputTokens: 0, outputTokens: 79 });
  });

  it("prices Ella's turn at $0.0002171, and $0.0022171 with the Cohere search a production turn adds", async () => {
    const turn = await priceTurn("brightwell");
    expect(turn.user).toBe("ella.brooks");
    expect(turn.answerUsd).toBeCloseTo(0.0002171, 10);
    expect(turn.withRerankUsd).toBeCloseTo(0.0022171, 10);
    expect(turn.calls.map((c) => [c.modelId, c.priced])).toEqual([
      ["rerank-v4.0-fast", true],
      ["gpt-6-luna", true],
    ]);
    expect(turn.unpriced).toEqual([]);
  });

  it("prices all four turns, and says whether Grafana answers", async () => {
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const lab = await observabilityLab(down);
    expect(lab.turns.ok && lab.turns.value.map((t) => Math.round(t.answerUsd * 1e7) / 1e7)).toEqual([
      0.0002411, 0.0003317, 0.0002171, 0.0005422,
    ]);
    expect(lab.grafana).toEqual({ url: "http://localhost:3001", up: false });
    const up = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    expect((await observabilityLab(up)).grafana.up).toBe(true);
  });
});
