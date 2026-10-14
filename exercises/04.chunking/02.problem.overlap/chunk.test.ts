// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ParsedDocument } from "#learn/parse/types";

import { chunk } from "#learn/chunk/chunk";
import { countTokens } from "#learn/chunk/tokens";
import { parse, PDF } from "#learn/parse/parse";
import { corpusFile } from "@/core/parse/corpus.test-helpers";

/** 13 tokens for any i from 1 to 60, so it costs 14 in a chunk: itself plus 1 for the join. */
const clause = (i: number) => `Clause ${i} of the Ashgrove agreement covers exit help.`;
const clauses = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => clause(from + i)).join(" ");
const doc = (...texts: string[]): ParsedDocument => ({
  mimeType: "text/markdown",
  pages: null,
  blocks: texts.map((text) => ({ kind: "text", text })),
});
const noOcr = {
  rasterise: () => Promise.reject(new Error("this page has a text layer")),
  ocr: () => Promise.reject(new Error("this page has a text layer")),
};

describe("overlap", () => {
  it("starts each chunk with the last whole sentences of the one before, as many as fit in overlapTokens", () => {
    expect(countTokens(clause(1))).toBe(13);
    // Two clauses cost 28, inside 30; a third would make 42.
    const chunks = chunk(doc(clauses(1, 12)), { targetTokens: 70, overlapTokens: 30 });
    expect(chunks.map((c) => c.text)).toEqual([clauses(1, 5), clauses(4, 8), clauses(7, 11), clauses(10, 12)]);
  });

  it("repeats nothing when the last sentence alone is over overlapTokens", () => {
    const chunks = chunk(doc(clauses(1, 12)), { targetTokens: 70, overlapTokens: 13 });
    expect(chunks.map((c) => c.text)).toEqual([clauses(1, 5), clauses(6, 10), clauses(11, 12)]);
  });

  it("repeats nothing when overlapTokens is 0", () => {
    const chunks = chunk(doc(clauses(1, 12)), { targetTokens: 70, overlapTokens: 0 });
    expect(chunks.map((c) => c.text)).toEqual([clauses(1, 5), clauses(6, 10), clauses(11, 12)]);
  });

  it("puts every pair of neighbouring sentences together in some chunk, and keeps each chunk inside the target", () => {
    const sentences = Array.from({ length: 40 }, (_, i) =>
      i % 3 === 0
        ? `Contract ${i} renews.`
        : `The payment run on day ${i} cleared every one of its ${i * 7} payouts on time.`,
    );
    const target = 90;
    const chunks = chunk(doc(sentences.join(" ")), { targetTokens: target, overlapTokens: 40 });
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(target);
    for (let i = 1; i < sentences.length; i++) {
      const pair = `${sentences[i - 1]} ${sentences[i]}`;
      expect(
        chunks.some((c) => c.text.includes(pair)),
        `sentences ${i - 1} and ${i} are never in one chunk`,
      ).toBe(true);
    }
  });

  it("carries clause 10.1 of the Ashgrove MSA across the cut at a target of 384", async () => {
    const msa = corpusFile("legal-contract-kpc-2026-0142-ashgrove-msa");
    const page2 = await parse(msa.bytes(), PDF, noOcr, { pages: { from: 2, to: 2 } });
    const chunks = chunk(page2, { targetTokens: 384, overlapTokens: 64 });
    expect(chunks.map((c) => c.tokenCount)).toEqual([346, 333]);
    expect(chunks[0].text).toContain("Nothing limits liability for fraud, death or personal injury.");
    expect(
      chunks[1].text.startsWith(
        "Nothing limits liability for fraud, death or personal injury.\n\n## 10. Termination\n\n10.1 Kestrel may terminate",
      ),
    ).toBe(true);
  });
});
