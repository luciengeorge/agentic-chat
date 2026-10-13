import { APICallError } from "ai";
import { MockRerankingModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { aiSdkReranker, overlapReranker } from "./rerank";

describe("overlapReranker", () => {
  const reranker = overlapReranker();

  it("ranks by the share of the query's words a document holds", async () => {
    const ranked = await reranker.rerank(
      "What is error KP-4031?",
      ["error codes in general", "KP-4031: the payout bank rejected the account. This error means...", "lunch menu"],
      3,
    );
    expect(ranked.map((entry) => entry.index)).toEqual([1, 0, 2]);
    expect(ranked[0].score).toBe(1);
    expect(ranked[2].score).toBe(0);
  });

  it("keeps the incoming order on a tie, and returns at most topN", async () => {
    const ranked = await reranker.rerank("hotel", ["hotel a", "hotel b", "hotel c"], 2);
    expect(ranked).toEqual([
      { index: 0, score: 1 },
      { index: 1, score: 1 },
    ]);
  });

  it("scores everything 0 for a query of stopwords", async () => {
    expect(await reranker.rerank("what is the", ["the what"], 1)).toEqual([{ index: 0, score: 0 }]);
  });
});

describe("aiSdkReranker", () => {
  it("passes the query, documents and topN through, and maps the ranking back to indexes", async () => {
    let seen: unknown;
    const model = new MockRerankingModelV4({
      doRerank: async (options) => {
        seen = options;
        return {
          ranking: [
            { index: 2, relevanceScore: 0.9 },
            { index: 0, relevanceScore: 0.4 },
          ],
        };
      },
    });
    const ranked = await aiSdkReranker(model, "mock").rerank("q", ["a", "b", "c"], 2);
    expect(ranked).toEqual([
      { index: 2, score: 0.9 },
      { index: 0, score: 0.4 },
    ]);
    expect(seen).toMatchObject({ query: "q", topN: 2, documents: { type: "text", values: ["a", "b", "c"] } });
  });

  it("retries a rate-limited call (429) with backoff", async () => {
    let calls = 0;
    const model = new MockRerankingModelV4({
      doRerank: async () => {
        calls += 1;
        if (calls === 1) {
          throw new APICallError({
            message: "rate limited",
            url: "https://api.cohere.com/v2/rerank",
            requestBodyValues: {},
            statusCode: 429,
            // A short retry-after keeps the test fast; the SDK honours it.
            responseHeaders: { "retry-after-ms": "10" },
            isRetryable: true,
          });
        }
        return { ranking: [{ index: 0, relevanceScore: 0.5 }] };
      },
    });
    expect(await aiSdkReranker(model, "mock").rerank("q", ["a"], 1)).toEqual([{ index: 0, score: 0.5 }]);
    expect(calls).toBe(2);
  });

  it("gives up after maxRetries", async () => {
    let calls = 0;
    const model = new MockRerankingModelV4({
      doRerank: async () => {
        calls += 1;
        throw new APICallError({
          message: "rate limited",
          url: "u",
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { "retry-after-ms": "1" },
          isRetryable: true,
        });
      },
    });
    await expect(aiSdkReranker(model, "mock", { maxRetries: 2 }).rerank("q", ["a"], 1)).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it("doesn't call the model with no documents", async () => {
    const model = new MockRerankingModelV4({
      doRerank: async () => {
        throw new Error("called");
      },
    });
    expect(await aiSdkReranker(model, "mock").rerank("q", [], 5)).toEqual([]);
  });
});
