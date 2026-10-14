// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ParsedDocument } from "#learn/parse/types";

import { chunk } from "#learn/chunk/chunk";
import { countTokens } from "#learn/chunk/tokens";
import { parse, PDF } from "#learn/parse/parse";
import { corpusFile } from "@/core/parse/corpus.test-helpers";

/** 13 tokens for any i from 1 to 60, so it costs 14 in a chunk: itself plus 1 for the space before the next. */
const clause = (i: number) => `Clause ${i} of the Ashgrove agreement covers exit help.`;
const clauses = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => clause(from + i));
const doc = (...texts: string[]): ParsedDocument => ({
  mimeType: "text/markdown",
  pages: null,
  blocks: texts.map((text) => ({ kind: "text", text })),
});
const noOcr = {
  rasterise: () => Promise.reject(new Error("this page has a text layer")),
  ocr: () => Promise.reject(new Error("this page has a text layer")),
};

describe("token sizing", () => {
  it("packs whole sentences until the next one wouldn't fit", () => {
    expect(countTokens(clause(1))).toBe(13);
    // 4 clauses cost 56 tokens; a fifth would make 70, over 60.
    const chunks = chunk(doc(clauses(1, 10).join(" ")), { targetTokens: 60 });
    expect(chunks.map((c) => c.text)).toEqual([
      clauses(1, 4).join(" "),
      clauses(5, 8).join(" "),
      clauses(9, 10).join(" "),
    ]);
    expect(chunks.map((c) => c.tokenCount)).toEqual([52, 52, 26]);
  });

  it("closes a chunk only when the next sentence wouldn't fit, never earlier", () => {
    const sentences = Array.from({ length: 40 }, (_, i) =>
      i % 3 === 0
        ? `Contract ${i} renews.`
        : `The payment run on day ${i} cleared every one of its ${i * 7} payouts on time.`,
    );
    const target = 90;
    const chunks = chunk(doc(sentences.join(" ")), { targetTokens: target });
    let next = 0;
    for (const [i, c] of chunks.entries()) {
      const held: string[] = [];
      while (next < sentences.length && c.text.includes(sentences[next])) held.push(sentences[next++]);
      expect(held.join(" "), `chunk ${i}`).toBe(c.text);
      const cost = held.reduce((sum, s) => sum + countTokens(s) + 1, 0);
      expect(cost, `chunk ${i} costs more than the target (tokens plus 1 a sentence)`).toBeLessThanOrEqual(target);
      if (next < sentences.length) {
        expect(cost + countTokens(sentences[next]) + 1, `chunk ${i} had room for the next sentence`).toBeGreaterThan(
          target,
        );
      }
    }
    expect(next).toBe(sentences.length);
  });

  it("measures in tokens: contract numbers fill a chunk in fewer characters than names do", () => {
    const names = "Tom Whitfield met Emily Tran and Helen Marsh.";
    const ids = "KPC-2026-0142 met KP-4031 and KPC-2025-0231.";
    // Within one character of each other, but 10 tokens against 23.
    expect([names.length, countTokens(names), ids.length, countTokens(ids)]).toEqual([45, 10, 44, 23]);
    const target = 100;
    const byName = chunk(doc(Array(30).fill(names).join(" ")), { targetTokens: target });
    const byId = chunk(doc(Array(30).fill(ids).join(" ")), { targetTokens: target });
    for (const c of [...byName, ...byId]) expect(c.tokenCount).toBeLessThanOrEqual(target);
    expect(byName).toHaveLength(4);
    expect(byId).toHaveLength(8);
  });

  it("gives a sentence as big as the target a chunk of its own, and never makes an empty chunk", () => {
    const big = `The exit plan covers ${clauses(1, 6).join(" and ")}`;
    const target = countTokens(big);
    const chunks = chunk(doc(big, clause(1), big), { targetTokens: target });
    expect(chunks.map((c) => c.text)).toEqual([big, clause(1), big]);
  });

  it("cuts page 2 of the Ashgrove MSA into 494 and 131 tokens, just before clause 12", async () => {
    const msa = corpusFile("legal-contract-kpc-2026-0142-ashgrove-msa");
    const page2 = await parse(msa.bytes(), PDF, noOcr, { pages: { from: 2, to: 2 } });
    const chunks = chunk(page2);
    expect(chunks.map((c) => c.tokenCount)).toEqual([494, 131]);
    expect(chunks[1].text.startsWith("## 12. Subcontracting")).toBe(true);
  });
});
