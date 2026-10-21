import { describe, expect, it } from "vitest";

import { costOf, priceKey } from "#learn/observability/prices";

describe("costOf", () => {
  it("prices gpt-6-luna's fresh input, cached input and output separately", () => {
    // 10,000 input of which 4,000 cached, 1,000 output: 6,000 x $0.10 + 4,000 x $0.01 + 1,000 x $0.50, per million.
    expect(costOf("gpt-6-luna", { inputTokens: 10000, cachedInputTokens: 4000, outputTokens: 1000 }).usd).toBeCloseTo(
      0.00114,
      10,
    );
  });

  it("finds a model however the provider names it", () => {
    expect(priceKey("openai.responses:gpt-6-luna")).toBe("gpt-6-luna");
    expect(priceKey("gpt-6-luna-2026-09-01")).toBe("gpt-6-luna");
    expect(priceKey("gpt-6-lunatic")).toBeNull();
  });

  it("prices embeddings by input and a rerank by the search", () => {
    expect(costOf("text-embedding-3-small", { inputTokens: 1_000_000 }).usd).toBeCloseTo(0.02);
    expect(costOf("rerank-v4.0-fast", {})).toEqual({ usd: 0.002, priced: true });
  });

  it("says a model it has no price for is unpriced, rather than free", () => {
    expect(costOf("qwen3-8b", { inputTokens: 5000 })).toEqual({ usd: 0, priced: false });
  });

  it("never counts more cached tokens than input tokens", () => {
    expect(costOf("gpt-6-luna", { inputTokens: 100, cachedInputTokens: 500 }).usd).toBeCloseTo(100 * 0.01 * 1e-6);
  });
});
