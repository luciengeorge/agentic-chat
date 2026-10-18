// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { ParseDeps } from "#learn/parse/types";

import { chunk } from "#learn/chunk/chunk";
import { parse, PDF } from "#learn/parse/parse";
import { corpusFile, recordedOcr } from "@/core/parse/corpus.test-helpers";

const noOcr: ParseDeps = {
  rasterise: () => Promise.reject(new Error("this test reads text-layer pages only")),
  ocr: () => Promise.reject(new Error("this test reads text-layer pages only")),
};
const report = corpusFile("finance-q3-2026-quarterly-report");
const numbersOf = async (range?: { from: number; to: number }) =>
  (await parse(report.bytes(), PDF, noOcr, range ? { pages: range } : {})).pages!.map((page) => page.number);

describe("page mapping", () => {
  it("numbers the pages of a range as they are in the whole document", async () => {
    expect(await numbersOf({ from: 2, to: 3 }), "pages 2 and 3 are pages 2 and 3, not 1 and 2").toEqual([2, 3]);
    const doc = await parse(report.bytes(), PDF, noOcr, { pages: { from: 2, to: 3 } });
    expect(doc.pages![0].blocks.find((block) => block.kind === "table")?.kind).toBe("table");
    expect(doc.blocks).toEqual(doc.pages!.flatMap((page) => page.blocks));
  });

  it("reads both ends of a range, down to a single page and the document's last", async () => {
    expect(await numbersOf({ from: 5, to: 7 }), "a range is inclusive: read page `to` too").toEqual([5, 6, 7]);
    expect(await numbersOf({ from: 7, to: 7 })).toEqual([7]);
    expect(await numbersOf({ from: 1, to: 1 })).toEqual([1]);
  });

  it("reads every page when there's no range", async () => {
    expect(await numbersOf()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("refuses a range that isn't whole pages inside the document, naming it", async () => {
    for (const [from, to] of [
      [0, 1],
      [7, 8],
      [3, 2],
      [1.5, 2],
    ]) {
      const parsing = parse(report.bytes(), PDF, noOcr, { pages: { from, to } });
      await expect(parsing, `pages ${from}-${to} of a 7-page report`).rejects.toThrow(RangeError);
      await expect(parse(report.bytes(), PDF, noOcr, { pages: { from, to } })).rejects.toThrow(
        `page range ${from}-${to} is outside 1-7`,
      );
    }
  });

  it("draws and OCRs a scanned page in a range by its own number", async () => {
    const msa = corpusFile("legal-contract-kpc-2026-0142-ashgrove-msa");
    const recorded = recordedOcr(msa.docId);
    const deps: ParseDeps = { rasterise: vi.fn(recorded.rasterise), ocr: recorded.ocr };
    const doc = await parse(msa.bytes(), PDF, deps, { pages: { from: 2, to: 3 } });
    expect(doc.pages!.map((page) => [page.number, page.method, page.ocrConfidence])).toEqual([
      [2, "text-layer", undefined],
      [3, "ocr", 44.8],
    ]);
    expect(deps.rasterise, "the scan for page 3 must draw page 3 of the document").toHaveBeenCalledExactlyOnceWith(
      expect.any(Uint8Array),
      3,
    );
  });

  it("puts the CHG-2026-0612 note on page 2,417 when a fan-out child reads pages 2,251 to 2,500", async () => {
    const filing = corpusFile("legal-regulatory-filing-2026");
    const range = await parse(filing.bytes(), PDF, noOcr, { pages: { from: 2251, to: 2500 } });
    const numbers = range.pages!.map((page) => page.number);
    expect([numbers.length, numbers[0], numbers.at(-1)]).toEqual([250, 2251, 2500]);
    const at = range.pages!.findIndex((page) => JSON.stringify(page.blocks).includes("CHG-2026-0612"));
    expect(at, "the note is the range's 167th page").toBe(166);
    expect(range.pages![at].number, "a page keeps its number in the whole filing").toBe(2417);
    const cited = chunk(range).find((piece) => piece.text.includes("CHG-2026-0612"))!;
    expect([cited.pageStart, cited.pageEnd]).toEqual([2417, 2417]);
  });
});
