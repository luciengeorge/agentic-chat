import { createCohere } from "@ai-sdk/cohere";
import { APICallError } from "ai";
import { MockRerankingModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { aiSdkReranker, overlapReranker, type Reranker, rerankCandidates } from "#learn/rerank/rerank";
import { FOS_DECISION, replayCohere } from "@/core/query/recorded";

const { question, pool, labels } = FOS_DECISION;
const texts = pool.map((candidate) => candidate.text);
const [filingPage845, reportPage3] = labels;
const fusedRank = (id: string) => pool.findIndex((candidate) => candidate.id === id) + 1;

function cohere() {
  const replay = replayCohere();
  const model = createCohere({ apiKey: "recorded", fetch: replay.fetch }).reranking("rerank-v4.0-fast");
  return { ...replay, reranker: aiSdkReranker(model, "cohere/rerank-v4.0-fast") };
}

const rateLimited = () =>
  new APICallError({
    message: "rate limited",
    url: "https://api.cohere.com/v2/rerank",
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: { "retry-after-ms": "1" },
    isRetryable: true,
  });

describe("aiSdkReranker", () => {
  it("maps Cohere's ranking back to the documents it was sent, by their place in that list", async () => {
    const { reranker, requests } = cohere();
    const ranked = await reranker.rerank(question, texts, 8);
    expect(requests[0], "send the query, every document and topN").toMatchObject({ query: question, top_n: 8 });
    expect(
      ranked.map((entry) => entry.index),
      "index is where the document sat in the list you sent (the ranking's originalIndex), not its place in the ranking",
    ).toEqual([27, 26, 5, 18, 0, 9, 12, 6]);
    expect(ranked[0].score).toBeCloseTo(0.9623, 4);
    expect(ranked[1].score).toBeCloseTo(0.9109, 4);
  });

  it("asks for no more than it sends, and makes no call with nothing to rank", async () => {
    let seen: { topN?: number } = {};
    const model = new MockRerankingModelV4({
      doRerank: async (options) => {
        seen = options;
        return { ranking: [{ index: 1, relevanceScore: 0.7 }] };
      },
    });
    const reranker = aiSdkReranker(model, "mock");
    expect(await reranker.rerank("hotel limit", ["a", "b"], 8)).toEqual([{ index: 1, score: 0.7 }]);
    expect(seen.topN, "topN can't be more than the documents sent: take the smaller of the two").toBe(2);

    const silent = aiSdkReranker(
      new MockRerankingModelV4({
        doRerank: async () => {
          throw new Error("called with nothing to rank");
        },
      }),
      "mock",
    );
    expect(await silent.rerank("q", [], 5), "no documents: return [] without calling the model").toEqual([]);
  });

  it("retries a 429 as many times as maxRetries says, and no more", async () => {
    let calls = 0;
    const model = new MockRerankingModelV4({
      doRerank: async () => {
        calls += 1;
        throw rateLimited();
      },
    });
    await expect(aiSdkReranker(model, "mock", { maxRetries: 1 }).rerank("q", ["a"], 1)).rejects.toThrow();
    expect(calls, "pass maxRetries to rerank(): 1 retry is 2 calls").toBe(2);
  });
});

describe("rerankCandidates", () => {
  it("reads the first `depth` candidates: the Compliance Monitoring Report's page 3, fused #27, is found at depth 30", async () => {
    expect(fusedRank(reportPage3.chunkIds[1])).toBe(27);
    const deep = await rerankCandidates(overlapReranker(), question, pool, { depth: 30, k: 8 });
    expect(
      deep.some((chunk) => reportPage3.chunkIds.includes(chunk.id)),
      "the report's page 3 is the 27th candidate: rerank the first `depth` of them, then keep the best k",
    ).toBe(true);
    const shallow = await rerankCandidates(overlapReranker(), question, pool, { depth: 8, k: 8 });
    expect(
      shallow.some((chunk) => reportPage3.chunkIds.includes(chunk.id)),
      "at depth 8 the reranker never sees the 27th candidate",
    ).toBe(false);
  });

  it("sends the reranker the text of at most `depth` candidates, in fused order", async () => {
    const sent: string[][] = [];
    const spy: Reranker = {
      name: "spy",
      rerank: async (query, documents, topN) => {
        sent.push(documents);
        return overlapReranker().rerank(query, documents, topN);
      },
    };
    await rerankCandidates(spy, question, pool, { depth: 10, k: 8 });
    await rerankCandidates(spy, question, pool.slice(0, 5), { depth: 30, k: 8 });
    expect(sent[0], "the first `depth` candidates' text, in the order given").toEqual(texts.slice(0, 10));
    expect(sent[1], "fewer candidates than the depth: send them all").toEqual(texts.slice(0, 5));
  });

  it("returns the best k, best first: each the candidate at the ranking's index, whole, with its score", async () => {
    const ranked = await overlapReranker().rerank(question, texts, 8);
    const results = await rerankCandidates(overlapReranker(), question, pool, { depth: 30, k: 8 });
    expect(results, "look each one up by the ranking's index, and keep every field of the candidate").toEqual(
      ranked.map(({ index, score }) => ({ ...pool[index], score })),
    );
  });

  it("with Cohere at depth 30, takes fused #28 and #27 to the top; at depth 8 neither comes back", async () => {
    const deep = await rerankCandidates(cohere().reranker, question, pool, { depth: 30, k: 8 });
    expect(deep.map((chunk) => fusedRank(chunk.id))).toEqual([28, 27, 6, 19, 1, 10, 13, 7]);
    expect(filingPage845.chunkIds).toContain(deep[0].id);
    expect(reportPage3.chunkIds).toContain(deep[1].id);
    expect(deep[0].score).toBeCloseTo(0.962, 3);
    expect(deep[1].score).toBeCloseTo(0.911, 3);
    expect(deep.slice(2).every((chunk) => chunk.path.endsWith("FCA Annual Regulatory Return 2026.pdf"))).toBe(true);

    const shallow = await rerankCandidates(cohere().reranker, question, pool, { depth: 8, k: 8 });
    expect(shallow.map((chunk) => fusedRank(chunk.id))).toEqual([6, 1, 7, 5, 4, 3, 2, 8]);
    expect(shallow.some((chunk) => chunk.id === deep[0].id || chunk.id === deep[1].id)).toBe(false);
  });
});
