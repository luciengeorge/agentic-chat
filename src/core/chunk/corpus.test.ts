import { afterAll, beforeAll, describe, expect, it } from "vitest";

// @vitest-environment node
// Parses and chunks the whole committed corpus with the real rasteriser and OCR. The OCR pages make
// this the slow suite (about 25 s of tesseract); nothing is cached between runs.
import type { Chunk } from "#learn/chunk/types";
import type { ParsedDocument } from "#learn/parse/types";

import { chunk, DEFAULT_TARGET_TOKENS } from "#learn/chunk/chunk";
import { countTokens } from "#learn/chunk/tokens";
import { parse } from "#learn/parse/parse";
import { loadWorld } from "@/fixtures/world";
import { ocrPng, terminateOcr } from "@/lib/parse/ocr";
import { rasterisePage } from "@/lib/parse/rasterise.server";

import { type CorpusFile, corpusFiles } from "../parse/corpus.test-helpers";

interface Parsed {
  file: CorpusFile;
  doc: ParsedDocument;
  chunks: Chunk[];
}

const files = corpusFiles();
const parsed = new Map<string, Parsed>();
const get = (docId: string) => parsed.get(docId)!;
const pageText = (docId: string, page: number) =>
  get(docId)
    .doc.pages!.find((p) => p.number === page)!
    .blocks.map((b) => (b.kind === "table" ? b.markdown : b.text))
    .join("\n");
const squash = (text: string) => text.replace(/\s+/g, " ");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

beforeAll(async () => {
  for (const file of files) {
    const doc = await parse(file.bytes(), file.mimeType, { rasterise: rasterisePage, ocr: ocrPng });
    parsed.set(file.docId, { file, doc, chunks: chunk(doc) });
  }
}, 240_000);

afterAll(async () => {
  await terminateOcr();
});

describe("parsing the corpus", () => {
  it("parses all 46 documents, with every PDF page accounted for", () => {
    expect(files).toHaveLength(46);
    for (const { file, doc, chunks } of parsed.values()) {
      expect(doc.blocks.length, file.docId).toBeGreaterThan(0);
      expect(chunks.length, file.docId).toBeGreaterThan(0);
      if (file.mimeType === "application/pdf") {
        expect(
          doc.pages?.map((p) => p.number),
          file.docId,
        ).toEqual(Array.from({ length: file.pages! }, (_, i) => i + 1));
      } else {
        expect(doc.pages, file.docId).toBeNull();
      }
    }
  });

  it("reads typeset PDFs from the text layer and OCRs scans and handwriting", () => {
    for (const { file, doc } of parsed.values()) {
      if (!doc.pages) continue;
      const methods = doc.pages.map((p) => p.method);
      if (file.format === "scan" || file.format === "handwriting") {
        expect(new Set(methods), file.docId).toEqual(new Set(["ocr"]));
        const floor = file.format === "handwriting" ? 75 : 40;
        for (const page of doc.pages) expect(page.ocrConfidence, file.docId).toBeGreaterThan(floor);
      } else if (file.format !== "pdf_mixed") {
        expect(new Set(methods), file.docId).toEqual(new Set(["text-layer"]));
      }
    }
    expect(pageText("hr-case-note-2026-014", 1)).toContain("HR-CASE-2026-014. Grievance meeting");
    expect(pageText("eng-incident-bridge-notes-2026-08-17", 1)).toContain("INC-2026-0817");
    expect(pageText("exec-offsite-notes-2026-09", 2)).toContain("KPC-2026-0412");
    expect(pageText("sales-order-form-marlow-finch", 1)).toContain("OF-2026-0388");
    expect(pageText("finance-ap-invoice-batch-b-2026-117", 2)).toContain("Calder Facilities Services Ltd");
  });

  it("reads the Ashgrove MSA's clauses from the text layer and its signature page by OCR", () => {
    const pages = get("legal-contract-kpc-2026-0142-ashgrove-msa").doc.pages!;
    expect(pages.map((p) => p.method)).toEqual(["text-layer", "text-layer", "ocr"]);
    expect(pages[2].ocrConfidence).toBeGreaterThan(30);
    expect(pageText("legal-contract-kpc-2026-0142-ashgrove-msa", 1)).toContain("| Committed charges |");
    expect(pageText("legal-contract-kpc-2026-0142-ashgrove-msa", 3)).toMatch(/Signature page[\s\S]*KPC-2026-0142/);
  });

  it("keeps a table split across pages as one block per page, header repeated", () => {
    const header = "| Line | Q3 2026 | Q2 2026 | Q3 2025 | Q3 2026 budget | Variance to budget |";
    for (const page of [2, 3]) {
      const tables = get("finance-q3-2026-quarterly-report")
        .doc.pages![page - 1].blocks.filter((b) => b.kind === "table")
        .map((b) => b.markdown);
      expect(tables, `page ${page}`).toHaveLength(1);
      expect(tables[0].startsWith(`${header}\n| --- |`), `page ${page}`).toBe(true);
    }
    expect(pageText("finance-q3-2026-quarterly-report", 3)).toContain("| EBITDA (from previous page) | 2,133 |");
  });
});

describe("chunking the corpus", () => {
  // The renderer guarantees identifiers are whole in the text layer, so this holds for every page
  // that isn't OCR'd; OCR misreads characters, which is the lesson of the scans.
  const IDENTIFIER = /\b(?:KPC-\d{4}-\d{4}|KP-\d{4}|K[ACP]-[A-Z]+-(?:\d+|BUY))\b/g;
  const world = loadWorld();

  it("keeps every contract number, error code, SKU and person's name whole in some chunk", () => {
    let checked = 0;
    for (const { file, chunks } of parsed.values()) {
      if (file.format === "scan" || file.format === "handwriting") continue;
      const source = file
        .source()
        .replace(/<!-- scan-begin -->[\s\S]*?<!-- scan-end -->/g, "")
        .replace(/\*\*|`/g, "");
      const names = world.tenants[file.tenant].users.map((u) => u.name).filter((name) => source.includes(name));
      const tokens = new Set([...(source.match(IDENTIFIER) ?? []), ...names]);
      const texts = chunks.map((c) => squash(c.text));
      for (const token of tokens) {
        expect(
          texts.some((text) => new RegExp(`(?<![\\w-])${escape(token)}(?![\\w-])`).test(text)),
          `${file.docId}: ${token}`,
        ).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it("exceeds the target only by one sentence or row", () => {
    for (const { file, chunks } of parsed.values()) {
      for (const c of chunks) {
        expect(c.tokenCount, `${file.docId} #${c.ordinal}`).toBe(countTokens(c.text));
        const excess = c.tokenCount - DEFAULT_TARGET_TOKENS;
        if (excess <= 0) continue;
        const lines = c.text.split("\n");
        const pieces = lines.flatMap((line) => line.split(/(?<=[.!?])\s+/)).map(countTokens);
        const header = lines[1]?.startsWith("| ---") ? countTokens(lines.slice(0, 2).join("\n")) : 0;
        expect(Math.max(...pieces) + header + 8, `${file.docId} #${c.ordinal}`).toBeGreaterThanOrEqual(excess);
      }
    }
  });

  it("sets both pages for PDF chunks and neither for markdown and DOCX", () => {
    for (const { file, chunks } of parsed.values()) {
      const pdf = file.mimeType === "application/pdf";
      chunks.forEach((c, i) => {
        expect(c.ordinal).toBe(i);
        if (pdf) {
          expect(c.pageStart, file.docId).not.toBeNull();
          expect(c.pageEnd! - c.pageStart!, file.docId).toBeGreaterThanOrEqual(0);
        } else {
          expect([c.pageStart, c.pageEnd], file.docId).toEqual([null, null]);
        }
      });
    }
  });

  it.each([
    [130, "Breach SG-2025-02. The shortfall above"],
    [328, "Breach SG-2026-01. The reconciliation"],
    [845, "DRN-2026-118230"],
    [883, "Major incident MI-2026-03"],
    [2417, "change CHG-2026-0612"],
    [2468, "payroll file PR-2026-0625-01"],
    [2861, "Merchant M-221449, Harlow Street Fashion Ltd"],
  ])("cites page %i of the filing for its fact", (page, fact) => {
    expect(pageText("legal-regulatory-filing-2026", page)).toContain(fact);
    const holding = get("legal-regulatory-filing-2026").chunks.filter((c) => squash(c.text).includes(fact));
    expect(holding.length).toBeGreaterThan(0);
    for (const c of holding) expect([c.pageStart, c.pageEnd]).toEqual([page, page]);
  });
});
