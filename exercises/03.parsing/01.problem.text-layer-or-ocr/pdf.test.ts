// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { PositionedText } from "#learn/parse/layout";
import type { ParseDeps } from "#learn/parse/types";

import { parse, PDF } from "#learn/parse/parse";
import { readPage, type Scan } from "#learn/parse/pdf";
import { corpusFile, corpusFiles, recordedOcr } from "@/core/parse/corpus.test-helpers";

const A4 = 842;
const run = (str: string, y = 700): PositionedText => ({ str, x: 63, y, width: str.length * 5, fontSize: 10 });
const layer = (...items: PositionedText[]) => ({ items, height: A4 });
const visible = (items: PositionedText[]) => items.reduce((n, item) => n + item.str.replace(/\s/g, "").length, 0);
const neverScan: Scan = () => Promise.reject(new Error("scan() was called on a page that has a text layer"));
const scanned = (text: string, confidence: number) => vi.fn<Scan>(async () => ({ text, confidence }));

describe("text layer or OCR", () => {
  it("reads a page with a text layer from it, and never OCRs it", async () => {
    const page = await readPage(
      2,
      layer(
        run("10.1 Kestrel may terminate for convenience on 6 months' written notice.", 700),
        run("It must then pay an early termination fee.", 686.5),
      ),
      neverScan,
    );
    expect(page).toEqual({
      number: 2,
      method: "text-layer",
      blocks: [
        {
          kind: "text",
          text: "10.1 Kestrel may terminate for convenience on 6 months' written notice. It must then pay an early termination fee.",
        },
      ],
    });
  });

  it("OCRs a page with no text layer, and keeps OCR's confidence", async () => {
    const scan = scanned("Signature page\n\nPriya Nair, Chief Technology Officer", 44.8);
    const page = await readPage(3, layer(), scan);
    expect(scan, "a page with no text layer has to go through scan()").toHaveBeenCalledOnce();
    expect(page).toEqual({
      number: 3,
      method: "ocr",
      ocrConfidence: 44.8,
      blocks: [
        { kind: "text", text: "Signature page" },
        { kind: "text", text: "Priya Nair, Chief Technology Officer" },
      ],
    });
  });

  it("counts visible characters: spaces and a stamped page number aren't a text layer", async () => {
    const spaces = Array.from({ length: 30 }, () => run(" "));
    const stamp = [...spaces, run("Page 3 of 3", 40)];
    expect([spaces.length, visible(spaces), visible(stamp)]).toEqual([30, 0, 8]);
    for (const items of [spaces, stamp]) {
      const scan = scanned("Signed for and on behalf of Kestrel Pay Ltd", 61.2);
      const page = await readPage(3, layer(...items), scan);
      expect(
        page.method,
        `${items.length} items, ${visible(items)} visible characters: count characters without whitespace, not items or str.length`,
      ).toBe("ocr");
    }
  });

  it("drops the spaces inside a run too, not just at its ends: spaced-out letters are few characters", async () => {
    const spaced = [run("a b c d e f g h i j"), run("k l m n o", 686)];
    const trimmed = spaced.reduce((n, item) => n + item.str.trim().length, 0);
    expect([trimmed, visible(spaced)]).toEqual([28, 15]);
    const page = await readPage(4, layer(...spaced), scanned("Approved", 72.5));
    expect(
      page.method,
      "28 characters once trimmed, but 15 visible: trim() only cuts whitespace at the ends of a string. Remove every whitespace character, inside the run too",
    ).toBe("ocr");
  });

  it("takes exactly MIN_TEXT_LAYER_CHARS (20) visible characters as a text layer, and 19 as a picture", async () => {
    const twenty = [run("KPC-2026-0142"), run(" "), run("signed.", 686)];
    const nineteen = [run("KPC-2026-0142"), run(" "), run("signed", 686)];
    expect([visible(twenty), visible(nineteen)]).toEqual([20, 19]);
    const twentyRead = await readPage(1, layer(...twenty), scanned("KPC-2026-0142 signed.", 90));
    expect(twentyRead.method, "20 visible characters is a text layer: compare with >=, not >").toBe("text-layer");
    const nineteenRead = await readPage(1, layer(...nineteen), scanned("KPC-2026-0142 signed", 90));
    expect(nineteenRead.method, "19 visible characters is under MIN_TEXT_LAYER_CHARS: OCR the page").toBe("ocr");
  });

  it("OCRs exactly the corpus's 12 scanned pages, and reads the blank page with a footer from its text layer", async () => {
    const ocrd: string[] = [];
    for (const file of corpusFiles()) {
      if (file.mimeType !== PDF || file.docId === "legal-regulatory-filing-2026") continue;
      const doc = await parse(file.bytes(), PDF, recordedOcr(file.docId));
      for (const page of doc.pages!) if (page.method === "ocr") ocrd.push(`${file.docId} ${page.number}`);
    }
    expect(ocrd.sort()).toEqual([
      "eng-incident-bridge-notes-2026-08-17 1",
      "eng-incident-bridge-notes-2026-08-17 2",
      "exec-offsite-notes-2026-09 1",
      "exec-offsite-notes-2026-09 2",
      "finance-ap-invoice-batch-b-2026-117 1",
      "finance-ap-invoice-batch-b-2026-117 2",
      "finance-ap-invoice-batch-b-2026-117 3",
      "hr-case-note-2026-014 1",
      "hr-case-note-2026-014 2",
      "legal-contract-kpc-2026-0142-ashgrove-msa 3",
      "sales-order-form-marlow-finch 1",
      "sales-order-form-marlow-finch 2",
    ]);
    // 33 visible characters, all in the footer, which layout drops: an empty page, read in milliseconds.
    const priceList = await parse(
      corpusFile("sales-price-list-2026").bytes(),
      PDF,
      recordedOcr("sales-price-list-2026"),
      {
        pages: { from: 2, to: 2 },
      },
    );
    expect(priceList.pages).toEqual([{ number: 2, method: "text-layer", blocks: [] }]);
  });

  it("reads the Ashgrove MSA's pages 1 and 2 from the text layer, and OCRs its signed page 3 at 44.8", async () => {
    const msa = corpusFile("legal-contract-kpc-2026-0142-ashgrove-msa");
    const recorded = recordedOcr(msa.docId);
    const deps: ParseDeps = { rasterise: vi.fn(recorded.rasterise), ocr: recorded.ocr };
    const doc = await parse(msa.bytes(), PDF, deps);
    expect(doc.pages!.map((page) => [page.number, page.method, page.ocrConfidence])).toEqual([
      [1, "text-layer", undefined],
      [2, "text-layer", undefined],
      [3, "ocr", 44.8],
    ]);
    expect(deps.rasterise, "only page 3 should be drawn and OCR'd").toHaveBeenCalledOnce();
    expect(deps.rasterise).toHaveBeenCalledWith(expect.any(Uint8Array), 3);
    const signed = doc.pages![2].blocks.map((block) => (block.kind === "text" ? block.text : "")).join(" ");
    expect(signed).toContain("KPC-2026-0142");
    expect(signed).toContain("RECEIVED BY KESTREL LEGAL 19 MAR 2026");
  });
});
