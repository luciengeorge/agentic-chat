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
