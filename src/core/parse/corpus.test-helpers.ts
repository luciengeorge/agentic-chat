import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ParseDeps } from "#learn/parse/types";

const CORPUS = join(import.meta.dirname, "../../../fixtures/corpus");

export interface CorpusFile {
  tenant: string;
  docId: string;
  mimeType: string;
  /** The manifest's page count; PDFs only. */
  pages: number | null;
  /** The source's `format`: pdf, pdf_mixed, scan, handwriting, docx, md or generated. */
  format: string;
  traps: string[];
  bytes: () => Uint8Array<ArrayBuffer>;
  /** The source's body, after its frontmatter. */
  source: () => string;
}

interface ManifestItem {
  kind: string;
  doc_id?: string;
  traps?: string[];
  file?: { blob: string; mime_type: string; pages?: number };
}

/** Every file in the committed corpus build, with its markdown source. */
export function corpusFiles(): CorpusFile[] {
  const manifest = JSON.parse(readFileSync(join(CORPUS, "build/manifest.json"), "utf8")) as {
    sites: Record<string, { items: ManifestItem[] }>;
  };
  return Object.entries(manifest.sites).flatMap(([tenant, site]) =>
    site.items.flatMap((item) => {
      if (item.kind !== "file" || !item.file || !item.doc_id) return [];
      const { blob, mime_type, pages } = item.file;
      const sourcePath = join(CORPUS, "sources", tenant, `${item.doc_id}.md`);
      const raw = readFileSync(sourcePath, "utf8");
      const format = /^format:\s*(\S+)/m.exec(raw)?.[1] ?? "";
      return [
        {
          tenant,
          docId: item.doc_id,
          mimeType: mime_type,
          pages: pages ?? null,
          format,
          traps: item.traps ?? [],
          bytes: () => new Uint8Array(readFileSync(join(CORPUS, "build", blob))),
          source: () => raw.replace(/^---\n[\s\S]*?\n---\n/, ""),
        },
      ];
    }),
  );
}

export function corpusFile(docId: string): CorpusFile {
  const file = corpusFiles().find((f) => f.docId === docId);
  if (!file) throw new Error(`no corpus file ${docId}`);
  return file;
}

/** What tesseract.js read on each page without a text layer: `scripts/ocr-record.ts` writes it. */
const OCR_RECORDING = join(import.meta.dirname, "ocr-recording.json");

/**
 * OCR as tesseract.js really read the document's scanned pages, replayed: the same text and confidences as the app
 * gets, without the 2 to 9 seconds a document takes. Rasterising is skipped (the "PNG" carries the page number),
 * and a page that wasn't recorded throws.
 */
export function recordedOcr(docId: string): ParseDeps {
  const recording = JSON.parse(readFileSync(OCR_RECORDING, "utf8")) as Record<
    string,
    Record<string, { text: string; confidence: number }>
  >;
  const pages = recording[docId] ?? {};
  return {
    rasterise: async (_pdf, page) => Uint8Array.of(page >> 8, page & 255),
    ocr: async (png) => {
      const page = (png[0] << 8) | png[1];
      const read = pages[page];
      if (!read) throw new Error(`no recorded OCR for ${docId} page ${page}`);
      return read;
    },
  };
}
