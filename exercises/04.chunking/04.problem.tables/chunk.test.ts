// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { Block, ParsedDocument } from "#learn/parse/types";

import { chunk } from "#learn/chunk/chunk";
import { countTokens } from "#learn/chunk/tokens";
import { parse, PDF } from "#learn/parse/parse";
import { tableBlock } from "#learn/parse/tables";
import { corpusFile } from "@/core/parse/corpus.test-helpers";

const doc = (...blocks: Block[]): ParsedDocument => ({ mimeType: "text/markdown", pages: null, blocks });
const register = (count: number, columns = ["Contract no.", "Owner", "Notes"]) =>
  tableBlock([
    columns,
    ...Array.from({ length: count }, (_, i) => [
      `KPC-2026-${String(i + 1).padStart(4, "0")}`,
      "Emily Tran",
      `Renews every ${i + 1} months`,
    ]),
  ]);
const headerOf = (table: { markdown: string }) => table.markdown.split("\n").slice(0, 2).join("\n");
const rowsOf = (table: { markdown: string }) => table.markdown.split("\n").slice(2);
const noOcr = {
  rasterise: () => Promise.reject(new Error("this page has a text layer")),
  ocr: () => Promise.reject(new Error("this page has a text layer")),
};

describe("table-aware chunking", () => {
  it("cuts a table only between rows, and every row lands whole in exactly one chunk", () => {
    const table = register(60);
    const chunks = chunk(doc(table), { targetTokens: 150, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.flatMap((c) => c.text.split("\n").slice(2))).toEqual(rowsOf(table));
  });

  it("starts every chunk that holds rows with the table's header, even after text", () => {
    const table = register(30);
    const chunks = chunk(doc({ kind: "text", text: "The register lists every live contract." }, table), {
      targetTokens: 120,
      overlapTokens: 0,
    });
    expect(
      chunks[0].text.startsWith(`The register lists every live contract.\n\n${headerOf(table)}\n| KPC-2026-0001`),
    ).toBe(true);
    for (const c of chunks.slice(1)) expect(c.text.startsWith(`${headerOf(table)}\n| KPC-`)).toBe(true);
  });

  it("counts the repeated header against the target, and fills each chunk as far as it leaves room", () => {
    const table = register(40, ["Contract number", "Owner of the contract", "Renewal terms and notice period"]);
    const header = countTokens(headerOf(table));
    const target = 120;
    const chunks = chunk(doc(table), { targetTokens: target, overlapTokens: 0 });
    const rows = rowsOf(table);
    let next = 0;
    for (const [i, c] of chunks.entries()) {
      expect(c.tokenCount, `chunk ${i}`).toBeLessThanOrEqual(target);
      const held = c.text.split("\n").slice(2);
      next += held.length;
      const cost = header + held.reduce((sum, row) => sum + countTokens(row) + 1, 0);
      if (next < rows.length) {
        expect(cost + countTokens(rows[next]) + 1, `chunk ${i} had room for one more row`).toBeGreaterThan(target);
      }
    }
  });

  it("keeps a table that has only a header as it is", () => {
    const table = tableBlock([["Contract no.", "Owner"]]);
    expect(chunk(doc(table)).map((c) => c.text)).toEqual([table.markdown]);
  });

  it("repeats whole rows as overlap, after the header", () => {
    const table = register(30);
    const chunks = chunk(doc(table), { targetTokens: 120, overlapTokens: 30 });
    for (let i = 1; i < chunks.length; i++) {
      const before = chunks[i - 1].text.split("\n").slice(2);
      const after = chunks[i].text.split("\n");
      expect(after.slice(0, 2).join("\n")).toBe(headerOf(table));
      expect(after[2], `chunk ${i} starts with a row from chunk ${i - 1}`).toBe(before.at(-1));
    }
  });

  it("keeps Tom Whitfield's contract whole on page 5 of the contract register", async () => {
    const file = corpusFile("legal-contract-register");
    const page5 = await parse(file.bytes(), PDF, noOcr, { pages: { from: 5, to: 5 } });
    const chunks = chunk(page5);
    expect(chunks.map((c) => c.tokenCount)).toEqual([492, 417]);
    const row = chunks[1].text.split("\n").find((line) => line.startsWith("| KPC-2026-0301 |"));
    expect(row).toBe(
      "| KPC-2026-0301 | Ostrander Tax Advisers LLP | EU VAT and OSS registration advice | Tom Whitfield | 15/06/2026 | 31/10/2026 | Fixed | £80,000 fixed fee |",
    );
    expect(chunks[1].text.split("\n")[2].startsWith("| KPC-2026-0298 |")).toBe(true);
  });
});
