// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { TextMessage } from "#learn/model/types";
import type { RetrievedChunk } from "#learn/retrieve/types";

import { buildPrompt, countTokens, fitHistory, fitSources, renderSource } from "#learn/generate/prompt";
import { recordedTurn } from "@/core/generate/recorded";

const chunk = (id: string, text: string): RetrievedChunk => ({
  id,
  documentId: `doc-${id}`,
  title: `Expenses policy ${id}`,
  path: `/HR/Policies/${id}.pdf`,
  text,
  pageStart: 2,
  pageEnd: 2,
  section: null,
  score: 1,
});

const V2 = chunk("v2", "Hotel, London | £200 a night");
const V1 = chunk("v1", "Hotel, London | £180 a night");
const BIG = chunk("big", "Receipts are needed for every claim. ".repeat(40));
const cost = (label: string, c: RetrievedChunk) => countTokens(renderSource(label, c));

describe("fitting the sources", () => {
  it("labels the sources S1, S2... in rank order and keeps each chunk's ids and text", () => {
    const { sources, rendered, omitted } = fitSources([V2, V1], 6000);
    expect(sources.map((s) => [s.label, s.chunkId, s.documentId])).toEqual([
      ["S1", "v2", "doc-v2"],
      ["S2", "v1", "doc-v1"],
    ]);
    expect(sources[0]).toMatchObject({ title: V2.title, path: V2.path, pageStart: 2, pageEnd: 2, text: V2.text });
    expect(rendered).toEqual([renderSource("S1", V2), renderSource("S2", V1)]);
    expect(omitted).toEqual([]);
  });

  it("skips a chunk that doesn't fit and still tries the ones after it", () => {
    const budget = cost("S1", V2) + cost("S2", V1);
    const fitted = fitSources([V2, BIG, V1], budget);
    expect(
      fitted.sources.map((s) => s.chunkId),
      "the big chunk doesn't fit, but v1 after it does: skip and carry on, don't stop",
    ).toEqual(["v2", "v1"]);
    expect(fitted.omitted).toEqual(["big"]);
    expect(fitted.tokens, "the tokens spent are the rendered blocks' counts, added up").toBe(budget);
  });

  it("labels by place among the sources that went in, so the model sees S1, S2 with no gap", () => {
    const fitted = fitSources([V2, BIG, V1], cost("S1", V2) + cost("S2", V1));
    expect(
      fitted.sources.map((s) => s.label),
      "v1 is the second source the model reads, so it's S2, not S3 (its place in the ranking)",
    ).toEqual(["S1", "S2"]);
    expect(fitted.rendered[1]).toContain('<source id="S2"');
  });

  it("counts the rendered block, tag and title included, not just the chunk's text", () => {
    const budget = countTokens(V2.text) + 5;
    expect(cost("S1", V2)).toBeGreaterThan(budget);
    const fitted = fitSources([V2], budget);
    expect(
      fitted.sources,
      `the text is ${countTokens(V2.text)} tokens but the model reads ${cost("S1", V2)}: count renderSource's output`,
    ).toEqual([]);
    expect(fitted.omitted).toEqual(["v2"]);
  });

  it("never goes over the budget, and takes a chunk that fits it exactly", () => {
    const exact = fitSources([V2], cost("S1", V2));
    expect(exact.sources).toHaveLength(1);
    expect(exact.tokens, "count the rendered block").toBe(cost("S1", V2));
    expect(fitSources([V2], cost("S1", V2) - 1).sources, "one token short: it doesn't fit").toEqual([]);
  });
});

describe("fitting the history", () => {
  const turn = (role: TextMessage["role"], content: string): TextMessage => ({ role, content });
  const history = [
    turn("user", "What is the hotel limit for a night in London?"),
    turn("assistant", 'It is £200 a night [[S2: "Hotel, London | £200 a night"]].'),
    turn("user", "And in Dublin?"),
    turn("assistant", 'Dublin is €180 a night [[S4: "Hotel, Lisbon or Dublin | €180 a night"]].'),
  ];

  it("keeps the newest turns, oldest first, without their old citations", () => {
    const kept = fitHistory(history, 1500);
    expect(kept.messages, "newest first, kept oldest first, and an answer loses its [[...]] citations").toEqual([
      turn("user", "What is the hotel limit for a night in London?"),
      turn("assistant", "It is £200 a night."),
      turn("user", "And in Dublin?"),
      turn("assistant", "Dublin is €180 a night."),
    ]);
    expect(kept.tokens).toBe(kept.messages.reduce((sum, m) => sum + countTokens(m.content), 0));
  });

  it("ends the history at the first turn that doesn't fit, instead of skipping it for an older one", () => {
    const long = [turn("user", "Short?"), turn("assistant", "word ".repeat(300)), ...history.slice(2)];
    const budget = countTokens("And in Dublin?") + countTokens("Dublin is €180 a night.") + countTokens("Short?");
    expect(
      fitHistory(long, budget).messages.map((m) => m.content),
      "the long answer doesn't fit, so the history stops there: going on to 'Short?' would put two questions together",
    ).toEqual(["And in Dublin?", "Dublin is €180 a night."]);
  });

  it("starts on a user turn, and gives back the tokens of an answer it drops", () => {
    const budget =
      countTokens("And in Dublin?") + countTokens("Dublin is €180 a night.") + countTokens("It is £200 a night.");
    const kept = fitHistory(history, budget);
    expect(
      kept.messages.map((m) => m.role),
      "an answer with no question before it is dropped",
    ).toEqual(["user", "assistant"]);
    expect(kept.tokens, "count only the turns you kept").toBe(
      countTokens("And in Dublin?") + countTokens("Dublin is €180 a night."),
    );
  });

  it("puts the history before the sources and the question", () => {
    const prompt = buildPrompt({ question: "And in Lisbon?", chunks: [V2], history });
    expect(prompt.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(prompt.messages.at(-1)!.content).toMatch(
      /^<sources>\n<source id="S1"[\s\S]*<question>\nAnd in Lisbon\?\n<\/question>$/,
    );
  });
});

describe("Grace's invoice question", () => {
  it("fits her 8 sources in 3,667 tokens, and 20 of the 30 reranked chunks in 5,984", () => {
    const grace = recordedTurn("invoice-hold");
    const app = buildPrompt({ question: grace.question, chunks: grace.chunks.slice(0, 8) });
    expect([app.sources.length, app.omitted.length, app.tokens.sources]).toEqual([8, 0, 3667]);

    const all = fitSources(grace.chunks, 6000);
    expect([all.sources.length, all.omitted.length, all.tokens]).toEqual([20, 10, 5984]);
    // The first 18 come to 5,714. The 19th chunk would add 290 (6,004), so it's skipped; the 20th adds 100 and goes
    // in as S19.
    expect(all.omitted[0], "chunk 19 doesn't fit").toBe(grace.chunks[18].id);
    expect(all.sources[18], "chunk 20 still fits, as the 19th source").toMatchObject({
      label: "S19",
      chunkId: grace.chunks[19].id,
    });
    expect(all.sources.at(-1)).toMatchObject({ label: "S20", chunkId: grace.chunks[22].id });
  });
});
