// Records what tesseract.js reads on every page of the corpus that has no text layer, with the real rasteriser,
// into src/core/parse/ocr-recording.json. Tests replay it through `recordedOcr` (corpus.test-helpers.ts), so a step
// can use the real OCR text and confidences without spending 2 to 9 seconds a document.
//
//   pnpm exec tsx scripts/ocr-record.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ParseDeps } from "#learn/parse/types";

import { parse, PDF } from "#learn/parse/parse";
import { corpusFiles } from "@/core/parse/corpus.test-helpers";
import { ocrPng, terminateOcr } from "@/lib/parse/ocr";
import { rasterisePage } from "@/lib/parse/rasterise.server";

const OUT = join(import.meta.dirname, "../src/core/parse/ocr-recording.json");

const recording: Record<string, Record<string, { text: string; confidence: number }>> = {};
try {
  for (const file of corpusFiles()) {
    if (file.mimeType !== PDF) continue;
    const pages: Record<string, { text: string; confidence: number }> = {};
    let current = 0;
    const deps: ParseDeps = {
      rasterise: async (pdf, page) => {
        current = page;
        return rasterisePage(pdf, page);
      },
      ocr: async (png) => {
        const read = await ocrPng(png);
        pages[current] = read;
        return read;
      },
    };
    await parse(file.bytes(), PDF, deps);
    if (Object.keys(pages).length) {
      recording[file.docId] = pages;
      console.log(
        file.docId,
        Object.entries(pages).map(([page, read]) => `${page}: ${read.confidence}`),
      );
    }
  }
} finally {
  await terminateOcr();
}
writeFileSync(OUT, `${JSON.stringify(recording, null, 2)}\n`);
