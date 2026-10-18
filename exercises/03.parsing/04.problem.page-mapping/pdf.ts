// 👨‍💼 A citation has to open the page a fact came from. Kestrel's regulatory filing has 3,000 pages, and
//    ingestion parses it in ranges of 250, in parallel. Every page still has to carry its number in the whole
//    filing, or the assistant cites page 167 for a fact on page 2,417.

import { getDocumentProxy } from "unpdf";

import type { Block, Page, ParseDeps } from "#learn/parse/types";

import { layoutPage, type PositionedText } from "#learn/parse/layout";

/** A page whose text layer has fewer visible characters than this is treated as an image and OCR'd. */
export const MIN_TEXT_LAYER_CHARS = 20;

export interface PageRange {
  /** 1-based, inclusive. */
  from: number;
  to: number;
}

/** An open PDF, as pdf.js hands it back. */
export type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

/** One page's text layer: its runs of text with their positions, and the page's height in points. */
export interface TextLayer {
  items: PositionedText[];
  height: number;
}

/** What OCR read on a page's image: its text, and the mean word confidence from 0 to 100. */
export type Scan = () => Promise<{ text: string; confidence: number }>;

export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const pdf = await open(bytes);
  try {
    return pdf.numPages;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/**
 * Reads each page's text layer and lays it out as blocks. A page with (almost) no text layer is a
 * scan: it's rasterised and OCR'd through `deps`, and its mean word confidence kept.
 */
export async function parsePdf(bytes: Uint8Array, deps: ParseDeps, range?: PageRange): Promise<Page[]> {
  const pdf = await open(bytes);
  try {
    return await readPages(pdf, bytes, deps, range);
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** Reads the pages in `range` (every page when it's missing), each numbered as it is in the whole document. */
export async function readPages(
  pdf: PdfDocument,
  bytes: Uint8Array,
  deps: ParseDeps,
  range?: PageRange,
): Promise<Page[]> {
  // 🐨 Work out the first and last page to read: `range.from` and `range.to`, or 1 and `pdf.numPages` when there's
  //    no range.
  // 🐨 Refuse a range that isn't whole page numbers inside the document, or that runs backwards: throw a RangeError
  //    that names it and the document's pages, like "page range 7-8 is outside 1-7".
  // 🐨 Read every page from the first to the last, both included, in order. For each: `pdf.getPage(number)`, then
  //    readPage(number, await textLayer(page), scan), where `scan` draws and OCRs that same page; then
  //    `page.cleanup()`. Return the pages.
  //
  // 💰 `Number.isInteger(n)`. A scan for page `number` is
  //    `async () => deps.ocr(await deps.rasterise(bytes, number))`. pdf.js counts pages from 1, as people do.
  //
  // 🦉 Why the document's numbers, not the range's. A chunk's pages come from these numbers (the chunker reads
  //    `page.number`), and a citation opens the document at that page. The fan-out child for the filing's pages
  //    2,251 to 2,500 reads 250 pages. Number them 1 to 250, the classic mistake, and the note about change
  //    CHG-2026-0612 on page 2,417 is cited as page 167, which is a schedule about something else. Twelve children
  //    would each claim pages 1 to 250, and their chunks would all say so.
  // 🦉 Why both ends. Ranges are inclusive: 2,251 to 2,500 is 250 pages. A loop that stops before `to` drops the
  //    last page of every range, twelve pages of the filing that nothing ever reads.
  // 🦉 Why refuse a bad range. pdf.js has no page 0 or page 3,001, and its own error doesn't say which range asked.
  //    A RangeError names the mistake, and ingestion treats it as bad input: retrying the same range can't help.
  // 🦉 Why one page at a time, with cleanup. pdf.js keeps each page it opened until it's told to let go. One page
  //    at a time, released as soon as it's read, keeps a 250-page range (or all 3,000) in little memory.
  // 🦉 New in this file, already written: readPage (step 1), and textLayer, which turns a pdf.js page into the runs
  //    readPage takes.
  //
  // 📜 https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFDocumentProxy.html (numPages, getPage)
  //
  // 🚨 The tests check that a range keeps the document's page numbers, that both ends are read, that no range means
  //    every page, that a range outside the document is refused, that a scanned page in a range is drawn by its own
  //    number, and that pages 2,251 to 2,500 of the filing put the CHG-2026-0612 note on page 2,417.
  throw new Error(
    `readPages(${pdf.numPages} pages, ${bytes.length} bytes, ${typeof deps}, range ${range ? `${range.from}-${range.to}` : "all"}) isn't written yet`,
  );
}

/**
 * One page as blocks. A page whose text layer has at least `MIN_TEXT_LAYER_CHARS` visible characters is laid out
 * from it; any other page is an image, so `scan` OCRs it, and the page keeps OCR's confidence.
 */
export async function readPage(number: number, layer: TextLayer, scan: Scan): Promise<Page> {
  const visible = layer.items.reduce((n, item) => n + item.str.replace(/\s/g, "").length, 0);
  if (visible >= MIN_TEXT_LAYER_CHARS) {
    return { number, blocks: layoutPage(layer.items, layer.height), method: "text-layer" };
  }
  const { text, confidence } = await scan();
  return { number, blocks: ocrBlocks(text), method: "ocr", ocrConfidence: confidence };
}

/** OCR gives lines of text with blank lines between paragraphs; each paragraph becomes a text block. */
export function ocrBlocks(text: string): Block[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph !== "")
    .map((paragraph) => ({ kind: "text", text: paragraph }));
}

/** A page's runs of text, with the baseline start and font size each one is drawn at. */
export async function textLayer(page: Awaited<ReturnType<PdfDocument["getPage"]>>): Promise<TextLayer> {
  const content = await page.getTextContent();
  const items: PositionedText[] = [];
  for (const item of content.items) {
    if (!("str" in item)) continue;
    const [, , c, d, x, y] = item.transform as number[];
    items.push({ str: item.str, x, y, width: item.width, fontSize: Math.hypot(c, d) });
  }
  return { items, height: page.getViewport({ scale: 1 }).height };
}

/** pdf.js may take ownership of the buffer it's given, so it gets a copy and the caller keeps `bytes`. */
function open(bytes: Uint8Array) {
  return getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
}
