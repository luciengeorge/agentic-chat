import { eq } from "drizzle-orm";

/**
 * The parsing lab's server side (section 03). It parses one page of a document the viewer can read with
 * `#learn/parse/parse` (the learner's code while a parsing step is active), and queues a document's low-confidence
 * pages with `#learn/parse/review`. Server only: the route's server functions import it.
 */
import type { Block, ParseDeps } from "#learn/parse/types";
import type { Tx } from "@/db/tenant";

import { parse, PDF, pdfPageCount } from "#learn/parse/parse";
import { pagesToReview, queueOcrReviews } from "#learn/parse/review";
import { documents } from "@/db/schema";
import { documentFile } from "@/routes/api/chat/-sources";

export interface ParsingLabDeps {
  withTenant: <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;
  parseDeps: ParseDeps;
  /** Pages under this mean OCR confidence are queued for review. */
  threshold: number;
}

export interface LabParsedPage {
  mimeType: string;
  /** The page shown (PDFs), or null for a document without pages. */
  page: number | null;
  /** The document's page count (PDFs). */
  pages: number | null;
  method: "text-layer" | "ocr" | null;
  confidence: number | null;
  threshold: number;
  /** The page would wait for review at this threshold. */
  dueForReview: boolean;
  blocks: Block[];
  /** What the parser threw, so the lab can show it. */
  error: string | null;
}

type Viewer = { tenantId: string; userId: string };

/** Parsed pages, by content hash and page, so paging back and forth doesn't OCR a page again. */
const cache = new Map<string, Awaited<ReturnType<typeof parse>>>();

async function digest(bytes: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).toString("hex");
}

async function readFile(deps: ParsingLabDeps, viewer: Viewer, documentId: string) {
  const file = await deps.withTenant(viewer.tenantId, (tx) => documentFile(tx, viewer, documentId));
  if (!file) throw new Error("No such document, or you can't read it.");
  return { bytes: new Uint8Array(file.bytes), mimeType: file.mimeType };
}

/** One page of a PDF (the whole document, for markdown and Word), as the parser reads it. */
export async function parsedPage(
  deps: ParsingLabDeps,
  viewer: Viewer,
  documentId: string,
  requested: number | null,
): Promise<LabParsedPage> {
  const { bytes, mimeType } = await readFile(deps, viewer, documentId);
  const pdf = mimeType === PDF;
  const pages = pdf ? await pdfPageCount(bytes) : null;
  const page = pdf ? Math.min(Math.max(requested ?? 1, 1), pages!) : null;
  const base = { mimeType, page, pages, threshold: deps.threshold };
  try {
    const key = `${await digest(bytes)}:${page}`;
    let doc = cache.get(key);
    if (!doc) {
      doc = await parse(bytes, mimeType, deps.parseDeps, page ? { pages: { from: page, to: page } } : {});
      if (cache.size >= 50) cache.delete(cache.keys().next().value!);
      cache.set(key, doc);
    }
    const parsed = doc.pages?.[0] ?? null;
    return {
      ...base,
      method: parsed?.method ?? null,
      confidence: parsed?.ocrConfidence ?? null,
      dueForReview: parsed ? pagesToReview([parsed], deps.threshold).length > 0 : false,
      blocks: parsed?.blocks ?? doc.blocks,
      error: null,
    };
  } catch (error) {
    return {
      ...base,
      method: null,
      confidence: null,
      dueForReview: false,
      blocks: [],
      error: (error as Error).message,
    };
  }
}

/**
 * Parses the whole document and queues its pages under the threshold, at its current version, as ingestion does
 * after it writes the chunks. Already-queued pages are left alone.
 */
export async function queueDocumentReviews(
  deps: ParsingLabDeps,
  viewer: Viewer,
  documentId: string,
): Promise<{ queued: number; ocrPages: number; error: string | null }> {
  const { bytes, mimeType } = await readFile(deps, viewer, documentId);
  if (mimeType !== PDF) return { queued: 0, ocrPages: 0, error: null };
  try {
    const doc = await parse(bytes, mimeType, deps.parseDeps);
    const ocrPages = doc.pages?.filter((page) => page.method === "ocr").length ?? 0;
    const queued = await deps.withTenant(viewer.tenantId, async (tx) => {
      const [row] = await tx.select({ version: documents.version }).from(documents).where(eq(documents.id, documentId));
      return queueOcrReviews(
        tx,
        { tenantId: viewer.tenantId, documentId, version: row.version },
        doc.pages,
        deps.threshold,
      );
    });
    return { queued, ocrPages, error: null };
  } catch (error) {
    return { queued: 0, ocrPages: 0, error: (error as Error).message };
  }
}
