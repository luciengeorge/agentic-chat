// 👨‍💼 Kestrel's PDFs come in two kinds, often in one file: pages typed on a computer, whose words are stored in
//    the file, and pages that were printed, signed and scanned back in, which are only pictures. Ingestion has to
//    tell them apart, page by page, or the signature page of a contract reads as empty.

import { getDocumentProxy } from "unpdf";

import type { PositionedText } from "#learn/parse/layout";
import type { Block, Page, ParseDeps } from "#learn/parse/types";

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
export async function readPages(pdf: PdfDocument, bytes: Uint8Array, deps: ParseDeps, range?: PageRange) {
  const from = range?.from ?? 1;
  const to = range?.to ?? pdf.numPages;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > pdf.numPages || from > to) {
    throw new RangeError(`page range ${from}-${to} is outside 1-${pdf.numPages}`);
  }
  const pages: Page[] = [];
  for (let number = from; number <= to; number++) {
    const page = await pdf.getPage(number);
    const scan: Scan = async () => deps.ocr(await deps.rasterise(bytes, number));
    pages.push(await readPage(number, await textLayer(page), scan));
    page.cleanup();
  }
  return pages;
}

/**
 * One page as blocks. A page whose text layer has at least `MIN_TEXT_LAYER_CHARS` visible characters is laid out
 * from it; any other page is an image, so `scan` OCRs it, and the page keeps OCR's confidence.
 */
export async function readPage(number: number, layer: TextLayer, scan: Scan): Promise<Page> {
  // 🐨 Count the page's visible characters: the length of every item's `str` once its whitespace is gone.
  // 🐨 With at least MIN_TEXT_LAYER_CHARS, the page has a text layer: return it as a "text-layer" page whose blocks
  //    are layoutPage(layer.items, layer.height). Don't call scan() on this path.
  // 🐨 With fewer, the page is a picture: await scan(), turn its text into blocks with ocrBlocks, and return an
  //    "ocr" page that keeps the confidence scan() gave as `ocrConfidence`.
  //
  // 💰 `str.replace(/\s/g, "")` drops every space, tab and newline. `items.reduce((n, item) => n + ..., 0)` sums.
  //    layoutPage comes from "#learn/parse/layout": import it next to PositionedText at the top.
  //
  // 🦉 Why count visible characters, not items. A page's text layer can hold runs you can't read: spaces, or a
  //    page number a scanner stamped on ("Page 3 of 3", 8 visible characters). pdf.js returns them as items like
  //    any other, so `items.length > 0` or a sum of `str.length` calls that page typed, and its scanned body is
  //    never read. Count only what a reader would see.
  // 🦉 Why page by page. One file can hold both kinds. The Ashgrove MSA's pages 1 and 2 have 2,102 and 2,202
  //    visible characters; page 3, the signed page, has none. Decide once per file and you either lose page 3 or
  //    OCR pages 1 and 2, which is slower, misreads characters, and loses the headings and tables that layoutPage
  //    finds from font sizes and positions. OCR gives plain paragraphs only.
  // 🦉 Why 20. Across the corpus's 93 PDF pages (the filing left out), 12 have no visible characters at all: the
  //    scans and the handwriting. The emptiest typed page, page 2 of the price list, has 33: a blank page with just
  //    its footer. Any cut between 1 and 33 splits them; 20 also catches a scan with a stamped page number.
  // 🦉 Why keep the confidence. It's OCR's own guess at how well it read the page, 0 to 100. Step 2 uses it to send
  //    the worst pages to a person.
  //
  // 📜 https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html (getTextContent)
  // 📜 https://github.com/naptha/tesseract.js (the OCR behind scan)
  //
  // 🚨 The tests check that a page with a text layer is never OCR'd, that a page without one is OCR'd and keeps its
  //    confidence, that spaces and a stamped page number don't count as a text layer while exactly 20 visible
  //    characters do, that the MSA reads pages 1 and 2 from the text layer and OCRs page 3 at 44.8, and that across
  //    the corpus exactly the 12 scanned pages go through OCR.
  throw new Error(`readPage(page ${number}, ${layer.items.length} items, ${typeof scan}) isn't written yet`);
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
