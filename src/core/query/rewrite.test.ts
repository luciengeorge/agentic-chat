import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { aiSdkChatModel } from "#learn/model/ai-sdk";

import { cleanRewrites, MAX_REWRITES, modelRewriter, noRewriter } from "./rewrite";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

function scripted(json: unknown) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(json) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    }),
  });
}

describe("modelRewriter", () => {
  it("asks for structured output and returns the cleaned queries", async () => {
    const model = scripted({ queries: ["hotel nightly limit London", "  ", "Hotel nightly limit London", "receipts"] });
    const rewrite = modelRewriter(aiSdkChatModel(model), "medium");

    expect(await rewrite("How much can I spend on a London hotel?")).toEqual([
      "hotel nightly limit London",
      "receipts",
    ]);

    const [call] = model.doGenerateCalls;
    expect(call.responseFormat).toMatchObject({ type: "json", name: "search_queries" });
    expect(call.reasoning).toBe("medium");
    expect(JSON.stringify(call.prompt)).toContain("How much can I spend on a London hotel?");
    expect(JSON.stringify(call.prompt)).toContain("kept exactly as written");
  });

  it("fails when the model's output doesn't match the schema", async () => {
    const rewrite = modelRewriter(aiSdkChatModel(scripted({ nope: true })), "low");
    await expect(rewrite("q")).rejects.toThrow();
  });
});

describe("cleanRewrites", () => {
  it("drops the question itself, case aside, and caps the count", () => {
    const many = ["Q", "a", "b", "c", "d"];
    expect(cleanRewrites("q", many)).toEqual(["a", "b", "c"]);
    expect(cleanRewrites("q", many)).toHaveLength(MAX_REWRITES);
  });
});

describe("noRewriter", () => {
  it("adds nothing", async () => {
    expect(await noRewriter("anything")).toEqual([]);
  });
});
