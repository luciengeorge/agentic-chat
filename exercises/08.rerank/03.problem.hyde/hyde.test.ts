import { createOpenAI } from "@ai-sdk/openai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { HYDE_INSTRUCTIONS, hydeEmbedding, MAX_PASSAGE_CHARS, modelHypothesis } from "#learn/query/hyde";
import { rrf } from "#learn/search/rrf";
import { FOS_DECISION, fosVector, recordedEmbedder, replay } from "@/core/query/recorded";

const { question, passage, labels, lists, hydeList } = FOS_DECISION;
/** The paragraph on filing page 845 that holds the decision, and the report's page 3 (fused #28 and #27). */
const DECISION = labels[0].chunkIds[2];
const REPORT = labels[1].chunkIds[1];

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

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
};

const embedder = recordedEmbedder({ [question]: fosVector("question"), [passage]: fosVector("passage") });

describe("modelHypothesis", () => {
  it("asks for a hypothetical_passage as structured output, with the instructions and the question, at the given effort", async () => {
    const { fetch, requests } = replay(FOS_DECISION.exchanges.hyde);
    const write = modelHypothesis(createOpenAI({ apiKey: "recorded", fetch })("gpt-6-luna"), "medium");
    expect(await write(question)).toBe(passage);

    const [body] = requests as { input: { role: string; content: unknown }[]; text: unknown; reasoning: unknown }[];
    expect(body.input[0], "the instructions go in `system`").toMatchObject({
      role: "developer",
      content: HYDE_INSTRUCTIONS,
    });
    expect(body.input.slice(1), "the question is the prompt").toEqual([
      { role: "user", content: [{ type: "input_text", text: question }] },
    ]);
    expect(body.text, "name the schema hypothetical_passage").toMatchObject({
      format: { name: "hypothetical_passage" },
    });
    expect(body.reasoning, "pass the reasoning effort you were given").toMatchObject({ effort: "medium" });
  });

  it("trims the passage and cuts it at MAX_PASSAGE_CHARS", async () => {
    const padded = await modelHypothesis(scripted({ passage: `  ${passage}\n` }), "low")(question);
    expect(padded, "trim the passage").toBe(passage);
    const long = await modelHypothesis(scripted({ passage: "Upheld. ".repeat(600) }), "low")(question);
    expect(long, `a passage over ${MAX_PASSAGE_CHARS} characters is cut there`).toHaveLength(MAX_PASSAGE_CHARS);
  });

  it("refuses an empty passage, and a reply that doesn't fit the schema", async () => {
    const empty = await modelHypothesis(scripted({ passage: "   " }), "low")(question).catch((error: unknown) => error);
    expect(empty, "an empty passage would search for nothing: throw").toBeInstanceOf(Error);
    const wrong = await modelHypothesis(scripted({ text: passage }), "low")(question).catch((error: unknown) => error);
    expect(wrong, "a reply without `passage` must throw").toBeInstanceOf(Error);
  });
});

describe("hydeEmbedding", () => {
  it("embeds the passage the writer wrote for the question, never the question", async () => {
    const asked: string[] = [];
    const result = await hydeEmbedding(question, {
      writer: async (q) => {
        asked.push(q);
        return passage;
      },
      embedder,
    });
    expect(asked, "the writer gets the question").toEqual([question]);
    expect(result.passage).toBe(passage);
    expect(result.embedding, "embed the passage: that's the whole of HyDE").toEqual(fosVector("passage"));
  });

  it("lands nearer both answers than the question does, and still loses the report from the reranker's 30", async () => {
    const { embedding } = await hydeEmbedding(question, { writer: async () => passage, embedder });
    const round = (x: number) => Math.round(x * 1000) / 1000;
    expect(round(cosine(embedding, fosVector(DECISION)))).toBe(0.624);
    expect(round(cosine(fosVector("question"), fosVector(DECISION)))).toBe(0.57);
    expect(round(cosine(embedding, fosVector(REPORT)))).toBe(0.564);
    expect(round(cosine(fosVector("question"), fosVector(REPORT)))).toBe(0.551);

    // Nearer, but the filing's complaint pages are nearer still: the passage's 40 nearest are all filing pages.
    expect(hydeList.includes(REPORT)).toBe(false);
    const rank = (ranked: { id: string }[]) => ranked.findIndex((entry) => entry.id === REPORT) + 1;
    expect(rank(rrf(lists.map((list) => list.ids)))).toBe(27);
    expect(rank(rrf([...lists.map((list) => list.ids), hydeList]))).toBe(33);
  });
});
