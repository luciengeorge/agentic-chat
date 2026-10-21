// @vitest-environment node
import { MockRerankingModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { answer } from "#learn/generate/answer";
import { APP_K, recordedTurn, replayModel, type TurnName } from "#learn/generate/recorded";
import { chargeRequest, currentRequestCost, withRequestCost } from "#learn/observability/ledger";
import { recordModelCall } from "#learn/observability/metrics";
import { costOf } from "#learn/observability/prices";
import { observeRequest } from "#learn/observability/request";
import { testTelemetry } from "#learn/observability/testing";
import { aiSdkReranker } from "#learn/rerank/rerank";
import { evalRecording, recordedUsage } from "@/core/eval/recorded";

const t = testTelemetry();
beforeAll(() => t.install());
afterAll(() => t.uninstall());

const luna = (inputTokens: number, outputTokens: number, cachedInputTokens = 0) =>
  costOf("gpt-6-luna", { inputTokens, cachedInputTokens, outputTokens });

describe("costOf", () => {
  it("prices fresh input, cached input and output at their own rates, per million tokens", () => {
    expect(
      luna(10_000, 1_000, 4_000).usd,
      "6,000 fresh × $0.10 + 4,000 cached × $0.01 + 1,000 out × $0.50, over a million. Cached tokens are part of the input: don't price them twice",
    ).toBeCloseTo(0.00114, 12);
    expect(luna(1_776, 79)).toEqual({ usd: expect.closeTo(0.0002171, 12), priced: true });
  });

  it("never prices more cached tokens than there were input tokens", () => {
    expect(costOf("gpt-6-luna", { inputTokens: 100, cachedInputTokens: 500 }).usd).toBeCloseTo(100 * 0.01 * 1e-6, 15);
  });

  it("reads a missing count as 0, and finds a model however the provider names it", () => {
    expect(costOf("openai.responses:gpt-6-luna", { outputTokens: 2_000 }).usd).toBeCloseTo(0.001, 12);
    expect(costOf("gpt-6-luna", {}).usd).toBe(0);
  });

  it("prices embeddings by their input, and a rerank by the search whatever its size", () => {
    expect(costOf("text-embedding-3-small", { inputTokens: 1_000_000 }).usd).toBeCloseTo(0.02, 12);
    expect(costOf("rerank-v4.0-fast", {}), "Cohere bills $2 per 1,000 searches").toEqual({ usd: 0.002, priced: true });
    expect(costOf("rerank-v4.0-fast", { inputTokens: 50_000 }).usd).toBe(0.002);
  });

  it("says a model it has no price for is unpriced, never free", () => {
    expect(
      costOf("qwen/qwen3-8b", { inputTokens: 5_000 }),
      "priced: false, so a report can say the table is missing it",
    ).toEqual({
      usd: 0,
      priced: false,
    });
  });

  it("prices section 18's 59 recorded judge and claim calls at $0.013408, cache hits included", () => {
    let usd = 0;
    let cached = 0;
    let calls = 0;
    for (const name of ["judge", "claims"] as const) {
      for (const items of Object.values(evalRecording(name)!.calls)) {
        for (const call of items) {
          const usage = recordedUsage(call);
          usd += costOf("gpt-6-luna", usage).usd;
          cached += usage.cachedInputTokens;
          calls += 1;
        }
      }
    }
    expect([calls, cached]).toEqual([59, 7_447]);
    expect(
      usd,
      "107,031 in (7,447 of them cached) and 6,751 out; with no cache discount it would be $0.014079",
    ).toBeCloseTo(0.013408, 6);
  });
});

describe("the request ledger", () => {
  const charge = (modelId: string, inputTokens: number) =>
    chargeRequest({ modelId, inputTokens, outputTokens: 0 }, costOf(modelId, { inputTokens }));
  const pause = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

  it("returns what the function returned and every call charged inside it, however deep", async () => {
    const deep = async () => {
      await pause();
      charge("gpt-6-luna", 1_000);
    };
    const { result, cost } = await withRequestCost(async () => {
      charge("gpt-6-luna", 1_000);
      await deep();
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          charge("text-embedding-3-small", 50);
          resolve();
        }, 1),
      );
      return "done";
    });
    expect(result).toBe("done");
    expect(cost).toMatchObject({ calls: 3, inputTokens: 2_050, cachedInputTokens: 0, outputTokens: 0, unpriced: [] });
    expect(cost.usd).toBeCloseTo((2_000 * 0.1 + 50 * 0.02) / 1e6, 15);
  });

  it("keeps each request's ledger to itself, however two requests interleave", async () => {
    const [a, b] = await Promise.all([
      withRequestCost(async () => {
        charge("gpt-6-luna", 100);
        await pause(10);
        charge("gpt-6-luna", 100);
      }),
      withRequestCost(async () => {
        await pause(5);
        charge("gpt-6-luna", 7);
      }),
    ]);
    expect(
      [a.cost.inputTokens, b.cost.inputTokens],
      "the second request's call came between the first's two: a ledger in a module variable mixes them",
    ).toEqual([200, 7]);
  });

  it("charges nothing outside a request, before or after one", async () => {
    charge("gpt-6-luna", 1_000);
    expect(
      currentRequestCost(),
      "no request runs here, so there's no ledger: a ledger set with enterWith outlives its request",
    ).toBeUndefined();
    await withRequestCost(async () => charge("gpt-6-luna", 1));
    expect(currentRequestCost(), "the ledger belongs to the request: none once it's over").toBeUndefined();
  });

  it("lists a model with no price once, however many calls it makes", async () => {
    const { cost } = await withRequestCost(async () => {
      charge("qwen/qwen3-8b", 10);
      charge("qwen/qwen3-8b", 10);
      charge("gpt-6-luna", 10);
    });
    expect(cost, "qwen/qwen3-8b has no price: listed in unpriced, once").toMatchObject({
      calls: 3,
      inputTokens: 30,
      unpriced: ["qwen/qwen3-8b"],
    });
    expect(cost.usd).toBeCloseTo((10 * 0.1) / 1e6, 15);
  });

  it("still reports what a request spent when it throws", async () => {
    await expect(
      observeRequest(t, { route: "chat_turn" }, async () => {
        recordModelCall(t.metrics, {
          provider: "openai",
          modelId: "gpt-6-luna",
          operation: "chat",
          inputTokens: 10_000,
        });
        throw new Error("model down");
      }),
    ).rejects.toThrow("model down");
    const span = t
      .spans()
      .filter((s) => s.name === "chat_turn")
      .at(-1)!;
    expect(span.attributes["agentic_chat.status"]).toBe("error");
    expect(
      span.attributes["agentic_chat.request.cost_usd"],
      "10,000 input tokens were spent before the throw: charge the ledger in place",
    ).toBeCloseTo(0.001, 12);
  });
});

describe("the recorded chat turns, priced as they replay", () => {
  async function replay(name: TurnName, extra?: () => Promise<unknown>) {
    const turn = recordedTurn(name);
    return withRequestCost(async () => {
      for await (const _ of answer({
        question: turn.question,
        retrieval: { query: turn.question, rewritten: [], chunks: turn.chunks.slice(0, APP_K), auditId: "a" },
        model: replayModel(name).model,
        reasoningEffort: "medium",
      }));
      await extra?.();
    });
  }

  it("costs Ella's Brightwell answer $0.0002171, and the other three what section 19 quotes", async () => {
    const costs: Record<string, unknown> = {};
    for (const name of ["brightwell", "invoice-hold", "london-hotel", "heron"] as const) {
      const { cost } = await replay(name);
      costs[name] = [cost.calls, cost.inputTokens, cost.outputTokens, Math.round(cost.usd * 1e7) / 1e7];
    }
    expect(costs, "one call each, charged by the AI SDK integration through your costOf and chargeRequest").toEqual({
      brightwell: [1, 1_776, 79, 0.0002171],
      "invoice-hold": [1, 3_907, 303, 0.0005422],
      "london-hotel": [1, 1_641, 154, 0.0002411],
      heron: [1, 2_777, 108, 0.0003317],
    });
  });

  it("costs $0.0022171 with one Cohere rerank: the search is 90% of the turn", async () => {
    const cohere = new MockRerankingModelV4({
      provider: "cohere",
      modelId: "rerank-v4.0-fast",
      doRerank: async () => ({ ranking: [{ index: 0, relevanceScore: 0.9 }] }),
    });
    const { cost } = await replay("brightwell", () =>
      aiSdkReranker(cohere, "cohere/rerank-v4.0-fast").rerank("Brightwell go-live", ["a", "b"], 1),
    );
    expect(cost.calls).toBe(2);
    expect(cost.usd).toBeCloseTo(0.0022171, 10);
  });
});
