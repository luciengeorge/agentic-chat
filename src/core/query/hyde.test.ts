import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { hashingEmbedder } from "#learn/embed/fake";

import { hydeEmbedding, MAX_PASSAGE_CHARS, modelHypothesis } from "./hyde";

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

const PASSAGE = "Hotel accommodation in London is reimbursed up to £200 per night, with an itemised receipt.";

describe("modelHypothesis", () => {
  it("asks for a passage as structured output, at the given effort, and trims it", async () => {
    const model = scripted({ passage: `  ${PASSAGE}  ` });
    const write = modelHypothesis(model, "low");

    expect(await write("How much can I spend on a London hotel?")).toBe(PASSAGE);
    const [call] = model.doGenerateCalls;
    expect(call.responseFormat).toMatchObject({ type: "json", name: "hypothetical_passage" });
    expect(call.reasoning).toBe("low");
    expect(JSON.stringify(call.prompt)).toContain("How much can I spend on a London hotel?");
    expect(JSON.stringify(call.prompt)).toContain("exactly as written");
  });

  it("caps a long passage and refuses an empty one", async () => {
    expect(await modelHypothesis(scripted({ passage: "x".repeat(5000) }), "low")("q")).toHaveLength(MAX_PASSAGE_CHARS);
    await expect(modelHypothesis(scripted({ passage: "  " }), "low")("q")).rejects.toThrow(/empty/);
    await expect(modelHypothesis(scripted({ nope: 1 }), "low")("q")).rejects.toThrow();
  });
});

describe("hydeEmbedding", () => {
  it("embeds the passage, not the question: it lands nearer the document's wording", async () => {
    const embedder = hashingEmbedder(256);
    const question = "How much can I spend on a London hotel?";
    const policy = "Hotel accommodation in London is reimbursed up to £200 per night.";
    const { passage, embedding } = await hydeEmbedding(question, { writer: async () => PASSAGE, embedder });

    expect(passage).toBe(PASSAGE);
    const [questionVector, policyVector] = await embedder.embed([question, policy]);
    const cosine = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i], 0);
    expect(cosine(embedding, policyVector)).toBeGreaterThan(cosine(questionVector, policyVector));
  });
});
