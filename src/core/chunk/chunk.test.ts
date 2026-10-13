import { describe, expect, it } from "vitest";

// @vitest-environment node
import type { Block, ParsedDocument } from "#learn/parse/types";

import { chunk } from "#learn/chunk/chunk";
import { countTokens } from "#learn/chunk/tokens";
import { tableBlock } from "#learn/parse/tables";

const sentence = (i: number) =>
  `Sentence ${i} names contract KPC-2026-${String(i).padStart(4, "0")} and Tom Whitfield.`;
const paragraph = (from: number, count: number): Block => ({
  kind: "text",
  text: Array.from({ length: count }, (_, i) => sentence(from + i)).join(" "),
});
const markdownDoc = (blocks: Block[]): ParsedDocument => ({ mimeType: "text/markdown", pages: null, blocks });

describe("chunk", () => {
  it("counts tokens with o200k_base", () => {
    expect(countTokens("hello world")).toBe(2);
    expect(countTokens("<|endoftext|>")).toBeGreaterThan(1);
  });

  it("starts a chunk at each heading and carries the nearest heading as the section", () => {
    const chunks = chunk(
      markdownDoc([
        { kind: "heading", level: 1, text: "Runbook" },
        { kind: "heading", level: 2, text: "1. Pipeline" },
        paragraph(1, 2),
        { kind: "heading", level: 2, text: "2. Rollback" },
        paragraph(3, 1),
      ]),
    );
    expect(chunks.map((c) => [c.ordinal, c.section, c.pageStart, c.pageEnd])).toEqual([
      [0, "1. Pipeline", null, null],
      [1, "2. Rollback", null, null],
    ]);
    expect(chunks[0].text).toBe(`# Runbook\n\n## 1. Pipeline\n\n${sentence(1)} ${sentence(2)}`);
    expect(chunks[0].tokenCount).toBe(countTokens(chunks[0].text));
  });

  it("splits a long section between sentences, with overlap, inside the target", () => {
    const doc = markdownDoc([{ kind: "heading", level: 2, text: "Contracts" }, paragraph(1, 120)]);
    const chunks = chunk(doc, { targetTokens: 200, overlapTokens: 40 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(200);
      expect(c.section).toBe("Contracts");
    }
    for (let i = 1; i < chunks.length; i++) {
      const firstSentence = /^.*?Whitfield\./.exec(chunks[i].text)![0];
      expect(chunks[i - 1].text).toContain(firstSentence);
    }
    for (let i = 1; i <= 120; i++) expect(chunks.some((c) => c.text.includes(sentence(i)))).toBe(true);
  });

  it("splits a table between rows and repeats its header", () => {
    const rows = [["Contract no.", "Owner", "Notes"]];
    for (let i = 1; i <= 60; i++) rows.push([`KPC-2026-${String(i).padStart(4, "0")}`, "Emily Tran", "Auto 12 months"]);
    const table = tableBlock(rows);
    const header = table.markdown.split("\n").slice(0, 2).join("\n");
    const chunks = chunk(markdownDoc([table]), { targetTokens: 150, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(3);
    const seen: string[] = [];
    for (const c of chunks) {
      expect(c.text.startsWith(`${header}\n`)).toBe(true);
      expect(c.tokenCount).toBeLessThanOrEqual(150);
      seen.push(...c.text.split("\n").slice(2));
    }
    expect(seen).toEqual(table.markdown.split("\n").slice(2));
  });

  it("splits a sentence longer than the target between words, never inside one", () => {
    const words = Array.from({ length: 400 }, (_, i) => `KP-${String(1000 + i)}`);
    const chunks = chunk(markdownDoc([{ kind: "text", text: words.join(" ") }]), {
      targetTokens: 100,
      overlapTokens: 0,
    });
    expect(chunks.flatMap((c) => c.text.split(" "))).toEqual(words);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(100);
  });

  it("lets one row longer than the target through whole", () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const table = tableBlock([
      ["A", "B"],
      ["short", "row"],
      ["long", long],
      ["after", "row"],
    ]);
    const chunks = chunk(markdownDoc([table]), { targetTokens: 60, overlapTokens: 10 });
    const holding = chunks.filter((c) => c.text.includes(long));
    expect(holding).toHaveLength(1);
    expect(holding[0].tokenCount).toBeGreaterThan(60);
  });

  it("sets both pages from the PDF pages a chunk spans", () => {
    const doc: ParsedDocument = {
      mimeType: "application/pdf",
      pages: [
        { number: 4, method: "text-layer", blocks: [{ kind: "heading", level: 2, text: "Revenue" }, paragraph(1, 1)] },
        { number: 5, method: "ocr", ocrConfidence: 88, blocks: [paragraph(2, 1)] },
      ],
      blocks: [],
    };
    expect(chunk(doc).map((c) => [c.pageStart, c.pageEnd, c.section])).toEqual([[4, 5, "Revenue"]]);
  });

  it("rejects an overlap as large as the target", () => {
    expect(() => chunk(markdownDoc([]), { targetTokens: 64, overlapTokens: 64 })).toThrow(RangeError);
    expect(chunk(markdownDoc([]))).toEqual([]);
  });
});
