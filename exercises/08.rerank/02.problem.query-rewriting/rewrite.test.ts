import { createOpenAI } from "@ai-sdk/openai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { aiSdkChatModel } from "#learn/model/ai-sdk";
import { cleanRewrites, MAX_REWRITES, modelRewriter, REWRITE_INSTRUCTIONS } from "#learn/query/rewrite";
import { rrf } from "#learn/search/rrf";
import { CHRISTMAS_FREEZE, type Exchange, replay } from "@/core/query/recorded";

function recordedModel(exchange: Exchange) {
  const { fetch, requests } = replay(exchange);
  return { model: aiSdkChatModel(createOpenAI({ apiKey: "recorded", fetch })("gpt-6-luna")), requests };
}

const scripted = (json: unknown) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(json) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 10, text: 10, reasoning: 0 },
      },
      warnings: [],
    }),
  });

describe("modelRewriter", () => {
  it("asks for search_queries as structured output: the instructions, the question alone, an explicit effort", async () => {
    const { model, requests } = recordedModel(CHRISTMAS_FREEZE.exchanges.rewrite);
    const rewrites = await modelRewriter(model, "medium")(CHRISTMAS_FREEZE.question);
    expect(rewrites).toEqual(CHRISTMAS_FREEZE.rewrites);

    const [body] = requests as { input: { role: string; content: unknown }[]; text: unknown; reasoning: unknown }[];
    expect(body.input[0], "the rules go in the instructions").toMatchObject({
      role: "developer",
      content: REWRITE_INSTRUCTIONS,
    });
    expect(body.input.slice(1), "the question is the one user message").toEqual([
      { role: "user", content: [{ type: "input_text", text: CHRISTMAS_FREEZE.question }] },
    ]);
    expect(body.text, "name the schema search_queries").toMatchObject({ format: { name: "search_queries" } });
    expect(body.reasoning, "pass the reasoning effort you were given").toMatchObject({ effort: "medium" });
  });

  it("cleans what the model returns", async () => {
    const rewrite = modelRewriter(
      aiSdkChatModel(scripted({ queries: ["  deployment freeze dates ", "When can't we ship code?", ""] })),
      "low",
    );
    expect(await rewrite("When can't we ship code?"), "run the model's queries through cleanRewrites").toEqual([
      "deployment freeze dates",
    ]);
  });

  it("fails when the model's answer doesn't fit the schema, so retrieval never quietly searches less", async () => {
    const rewrite = modelRewriter(aiSdkChatModel(scripted({ nope: true })), "low");
    const outcome = await rewrite("q").catch((error: unknown) => error);
    expect(outcome, "don't catch the failure and return []: let it throw").toBeInstanceOf(Error);
  });
});

describe("cleanRewrites", () => {
  it("trims each query and drops the blank ones", () => {
    expect(cleanRewrites("q", ["  winter freeze  ", "   ", ""])).toEqual(["winter freeze"]);
  });

  it("drops the question itself, whatever its case or spacing", () => {
    expect(
      cleanRewrites("  When can't we ship code?", ["when can't we ship code?", "WHEN CAN'T WE SHIP CODE? ", "freeze"]),
      "a rewrite that repeats the question adds its two lists again, and fusion counts them twice",
    ).toEqual(["freeze"]);
  });

  it("keeps the first spelling of a query that repeats, case aside, and the model's order", () => {
    expect(cleanRewrites("q", ["KPC-2026-0142 renewal", "kpc-2026-0142 RENEWAL", "Ashgrove MSA"])).toEqual([
      "KPC-2026-0142 renewal",
      "Ashgrove MSA",
    ]);
  });

  it(`stops at ${MAX_REWRITES}, counting only the queries it keeps`, () => {
    expect(cleanRewrites("q", ["Q", "a", "a", "b", "c", "d"]), "count what you keep, not what you were given").toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("expansion, on the recorded searches", () => {
  const listsFor = (query: string) => {
    const lists = CHRISTMAS_FREEZE.lists.filter((list) => list.query === query);
    if (lists.length !== 2) {
      throw new Error(`no recorded search for ${JSON.stringify(query)}: return each rewrite as the model wrote it`);
    }
    return lists.map((list) => list.ids);
  };
  const [freezeTable] = CHRISTMAS_FREEZE.labels[0].chunkIds;
  const fusedRank = (queries: string[]) =>
    rrf(queries.flatMap(listsFor)).findIndex((entry) => entry.id === freezeTable) + 1;

  it("lifts the runbook's freeze table from #13 to #4 for sam.patel's 'When can't we ship code over Christmas?'", async () => {
    const { question } = CHRISTMAS_FREEZE;
    const [bm25, vector] = listsFor(question);
    expect(bm25.includes(freezeTable), "the question's own words never reach the table by BM25").toBe(false);
    expect(vector[0]).toBe(freezeTable);
    expect(fusedRank([question])).toBe(13);

    const { model } = recordedModel(CHRISTMAS_FREEZE.exchanges.rewrite);
    const rewrites = await modelRewriter(model, "medium")(question);
    expect(rewrites).toHaveLength(3);
    expect(fusedRank([question, ...rewrites])).toBe(4);
    expect(rewrites.flatMap(listsFor).filter((list) => list.includes(freezeTable))).toHaveLength(6);
  });
});
