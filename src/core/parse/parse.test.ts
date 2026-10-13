import { describe, expect, it, vi } from "vitest";

// @vitest-environment node
import type { ParseDeps } from "#learn/parse/types";

import { htmlBlocks } from "#learn/parse/docx";
import { layoutPage, type PositionedText } from "#learn/parse/layout";
import { parseMarkdown } from "#learn/parse/markdown";
import { MARKDOWN, parse, PDF, pdfPageCount, UnsupportedDocumentError } from "#learn/parse/parse";
import { ocrBlocks } from "#learn/parse/pdf";
import { tableBlock } from "#learn/parse/tables";

import { corpusFile } from "./corpus.test-helpers";

const A4 = 842;
const text = (str: string, x: number, y: number, fontSize = 10, width = str.length * fontSize * 0.5) => ({
  str,
  x,
  y,
  width,
  fontSize,
});

const noDeps: ParseDeps = {
  rasterise: () => Promise.reject(new Error("rasterise was called")),
  ocr: () => Promise.reject(new Error("ocr was called")),
};

describe("layoutPage", () => {
  it("finds headings by size, joins a paragraph's lines and drops the footer", () => {
    const items: PositionedText[] = [
      text("Contract register", 63, 761, 18),
      text("How to read", 63, 700, 14),
      text("Every active contract worth", 63, 680),
      text("£25,000 a year is listed.", 63, 666.5),
      text("Register", 57, 31, 8),
      text("Page 1 of 6", 498, 31, 8),
    ];
    expect(layoutPage(items, A4)).toEqual([
      { kind: "heading", level: 1, text: "Contract register" },
      { kind: "heading", level: 2, text: "How to read" },
      { kind: "text", text: "Every active contract worth £25,000 a year is listed." },
    ]);
  });

  it("keeps a bullet and its wrapped lines as one block", () => {
    const items = [
      text("•", 63, 682, 10, 5),
      text("Numbers.", 79, 682),
      text("Contract numbers take", 125, 682),
      text("the form KPC-YYYY-NNNN.", 79, 668.5),
      text("•", 63, 649, 10, 5),
      text("Dates are day/month/year.", 79, 649),
    ];
    expect(layoutPage(items, A4)).toEqual([
      { kind: "text", text: "- Numbers. Contract numbers take the form KPC-YYYY-NNNN." },
      { kind: "text", text: "- Dates are day/month/year." },
    ]);
  });

  it("rebuilds a table from aligned cells, with wrapped cells and right-aligned numbers", () => {
    // Columns at 67, 139 and a right-aligned amount ending at 300; rows 16pt apart, wrapped lines 11pt.
    const items = [
      text("Contract no.", 67, 745, 9, 55),
      text("Owner", 139, 745, 9, 30),
      text("Annual value", 245, 745, 9, 55),
      text("KPC-2021-0034", 67, 728, 9, 64),
      text("Tom", 139, 728, 9, 18),
      text("£6,200,000", 255, 728, 9, 45),
      text("Whitfield", 139, 717, 9, 35),
      text("KPC-2022-0019", 67, 701, 9, 64),
      text("Emily Tran", 139, 701, 9, 45),
      text("£95,000", 268, 701, 9, 32),
      text("Brackets show costs.", 63, 680),
    ];
    expect(layoutPage(items, A4)).toEqual([
      {
        kind: "table",
        rows: 2,
        markdown: [
          "| Contract no. | Owner | Annual value |",
          "| --- | --- | --- |",
          "| KPC-2021-0034 | Tom Whitfield | £6,200,000 |",
          "| KPC-2022-0019 | Emily Tran | £95,000 |",
        ].join("\n"),
      },
      { kind: "text", text: "Brackets show costs." },
    ]);
  });
});

describe("tableBlock", () => {
  it("pads short rows and escapes pipes", () => {
    expect(tableBlock([["a", "b"], ["x | y"]])).toEqual({
      kind: "table",
      rows: 1,
      markdown: "| a | b |\n| --- | --- |\n| x \\| y |  |",
    });
  });
});

describe("parseMarkdown", () => {
  it("reads headings, tables, list items, code and paragraphs", () => {
    const source = [
      "# Deploy Runbook",
      "",
      "Owner: Nadia Kowalski.",
      "Last reviewed 4 September.",
      "",
      "| Type | Approval |",
      "|---|---|",
      "| Standard | 1 reviewer |",
      "| Emergency | The IC \\| on call |",
      "",
      "- [ ] Signed contract",
      "  and right-to-work check.",
      "1. Open a pull request.",
      "",
      "```sh",
      "kp-deploy promote",
      "```",
    ].join("\n");
    expect(parseMarkdown(source)).toEqual([
      { kind: "heading", level: 1, text: "Deploy Runbook" },
      { kind: "text", text: "Owner: Nadia Kowalski. Last reviewed 4 September." },
      {
        kind: "table",
        rows: 2,
        markdown: "| Type | Approval |\n| --- | --- |\n| Standard | 1 reviewer |\n| Emergency | The IC \\| on call |",
      },
      { kind: "text", text: "- [ ] Signed contract and right-to-work check." },
      { kind: "text", text: "1. Open a pull request." },
      { kind: "text", text: "```sh\nkp-deploy promote\n```" },
    ]);
  });
});

describe("htmlBlocks", () => {
  it("reads mammoth's headings, paragraphs, list items and tables", () => {
    const html =
      "<h2>3. Summary</h2><p>Fees &amp; terms</p><ul><li>One</li><li>Two<br />lines</li></ul>" +
      "<table><thead><tr><th><p><strong>Item</strong></p></th><th><p>Detail</p></th></tr></thead>" +
      "<tbody><tr><td><p>Agreement</p></td><td><p>KPC-2026-0187,</p><p>signed</p></td></tr></tbody></table>";
    expect(htmlBlocks(html)).toEqual([
      { kind: "heading", level: 2, text: "3. Summary" },
      { kind: "text", text: "Fees & terms" },
      { kind: "text", text: "- One" },
      { kind: "text", text: "- Two lines" },
      { kind: "table", rows: 1, markdown: "| Item | Detail |\n| --- | --- |\n| Agreement | KPC-2026-0187, signed |" },
    ]);
  });
});

describe("ocrBlocks", () => {
  it("makes a block of each paragraph", () => {
    expect(ocrBlocks("Bridge notes\nMon 17 Aug\n\n  \nTo do:\n")).toEqual([
      { kind: "text", text: "Bridge notes Mon 17 Aug" },
      { kind: "text", text: "To do:" },
    ]);
  });
});

describe("parse", () => {
  it("refuses a type it can't read, and a page range outside a PDF", async () => {
    const bytes = new TextEncoder().encode("# Hi");
    await expect(parse(bytes, "image/png", noDeps)).rejects.toThrow(UnsupportedDocumentError);
    await expect(parse(bytes, MARKDOWN, noDeps, { pages: { from: 1, to: 1 } })).rejects.toThrow(
      UnsupportedDocumentError,
    );
    await expect(parse(bytes, "text/markdown; charset=utf-8", noDeps)).resolves.toMatchObject({ pages: null });
  });

  it("parses a page range of a PDF with absolute page numbers", async () => {
    const report = corpusFile("finance-q3-2026-quarterly-report");
    expect(await pdfPageCount(report.bytes())).toBe(7);
    const doc = await parse(report.bytes(), PDF, noDeps, { pages: { from: 2, to: 3 } });
    expect(doc.pages?.map((page) => [page.number, page.method])).toEqual([
      [2, "text-layer"],
      [3, "text-layer"],
    ]);
    expect(doc.blocks).toEqual(doc.pages?.flatMap((page) => page.blocks));
    await expect(parse(report.bytes(), PDF, noDeps, { pages: { from: 7, to: 8 } })).rejects.toThrow(RangeError);
  });

  it("OCRs only the pages without a text layer, through the injected deps", async () => {
    const msa = corpusFile("legal-contract-kpc-2026-0142-ashgrove-msa");
    const bytes = msa.bytes();
    const png = new Uint8Array([1, 2, 3]);
    const deps = {
      rasterise: vi.fn(async () => png),
      ocr: vi.fn(async () => ({ text: "Signature page\n\nPriya Nair", confidence: 71.5 })),
    };
    const doc = await parse(bytes, PDF, deps);
    expect(deps.rasterise).toHaveBeenCalledExactlyOnceWith(bytes, 3);
    expect(deps.ocr).toHaveBeenCalledExactlyOnceWith(png);
    expect(doc.pages?.map((page) => [page.number, page.method, page.ocrConfidence])).toEqual([
      [1, "text-layer", undefined],
      [2, "text-layer", undefined],
      [3, "ocr", 71.5],
    ]);
    expect(doc.pages?.[2].blocks).toEqual([
      { kind: "text", text: "Signature page" },
      { kind: "text", text: "Priya Nair" },
    ]);
  });
});
