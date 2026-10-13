import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createWorker, OEM, type Worker } from "tesseract.js";

import type { ParseDeps } from "#learn/parse/types";

export type Ocr = ParseDeps["ocr"];

/** The English model ships in @tesseract.js-data/eng, so OCR never fetches it and never caches it in the cwd. */
const LANG_PATH = join(
  dirname(createRequire(import.meta.url).resolve("@tesseract.js-data/eng/package.json")),
  "4.0.0_best_int",
);

let worker: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  worker ??= createWorker("eng", OEM.LSTM_ONLY, { langPath: LANG_PATH, gzip: true, cacheMethod: "none" });
  return worker;
}

/**
 * OCRs a PNG with tesseract.js. Ingestion calls it through /api/ingest/ocr, not from a step: its worker
 * script and model are files it loads from node_modules. `confidence` is the mean of
 * the word confidences, 0 to 100; a page with no words scores 0.
 */
export const ocrPng: Ocr = async (png) => {
  const { data } = await (await getWorker()).recognize(Buffer.from(png), {}, { text: true, blocks: true });
  const words = (data.blocks ?? []).flatMap((block) =>
    block.paragraphs.flatMap((paragraph) => paragraph.lines.flatMap((line) => line.words)),
  );
  const confidence = words.length ? words.reduce((sum, word) => sum + word.confidence, 0) / words.length : 0;
  return { text: data.text, confidence: Math.round(confidence * 10) / 10 };
};

/** Stops the shared worker, so a script or test can exit. */
export async function terminateOcr(): Promise<void> {
  const current = worker;
  worker = null;
  if (current) await (await current).terminate();
}
