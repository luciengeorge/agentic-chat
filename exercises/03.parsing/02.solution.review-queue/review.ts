/**
 * The OCR review queue (section 03.2). OCR gives each word a confidence; a page whose mean is under the threshold
 * probably has misread words ("KPC-2O26-O142"), so it goes in `ocr_reviews` for a person to check. The page stays
 * searchable while it waits: its chunks are written as usual, and the queue only adds a row.
 *
 * A reviewer accepts the page as it is, or types what it really says. A correction re-chunks that page alone, plus
 * a neighbour page when one of its chunks runs across the page break (`spanToRecut`): the new chunks are embedded
 * and swapped in, in one transaction. Every other chunk of the document keeps its id and its embedding.
 */
import { sql } from "drizzle-orm";

import type { Chunk } from "#learn/chunk/types";
import type { Embedder } from "#learn/embed/embed";
import type { Page, ParseDeps } from "#learn/parse/types";
import type { Tx } from "@/db/tenant";

import { chunk } from "#learn/chunk/chunk";
import { parse, PDF } from "#learn/parse/parse";
import { ocrBlocks } from "#learn/parse/pdf";
import { readable } from "#learn/retrieve/acl";
import { uuidArray } from "#learn/search/sql";
import { chunks, ocrReviews } from "@/db/schema";

/**
 * Pages under this mean word confidence (0 to 100) are queued. On this corpus tesseract scores the handwriting 83
 * to 90, the scanned invoices and order form 51 to 67, and the MSA's signature page 45: at 70 the six scanned
 * pages are queued and the handwriting isn't.
 */
export const DEFAULT_OCR_REVIEW_THRESHOLD = 70;

export type OcrReviewStatus = "pending" | "accepted" | "corrected";

/** The OCR'd pages a person should check: those under the threshold. Text-layer pages are never queued. */
export function pagesToReview(pages: readonly Page[] | null, threshold = DEFAULT_OCR_REVIEW_THRESHOLD): Page[] {
  return (pages ?? []).filter((page) => page.method === "ocr" && (page.ocrConfidence ?? 0) < threshold);
}

/** A page's text as OCR read it: its paragraphs, a blank line apart, which `ocrBlocks` turns back into blocks. */
export function pageText(page: Page): string {
  return page.blocks.map((block) => (block.kind === "table" ? block.markdown : block.text)).join("\n\n");
}

/**
 * Queues the pages under the threshold, in the caller's transaction (the one that writes the chunks). A page
 * already queued at this version is left as it is, so a retried ingest step queues nothing twice. Returns the
 * number of pages it queued.
 */
export async function queueOcrReviews(
  tx: Tx,
  scope: { tenantId: string; documentId: string; version: number },
  pages: readonly Page[] | null,
  threshold = DEFAULT_OCR_REVIEW_THRESHOLD,
): Promise<number> {
  const due = pagesToReview(pages, threshold);
  if (due.length === 0) return 0;
  const rows = await tx
    .insert(ocrReviews)
    .values(
      due.map((page) => ({
        tenantId: scope.tenantId,
        documentId: scope.documentId,
        documentVersion: scope.version,
        page: page.number,
        confidence: page.ocrConfidence ?? 0,
        ocrText: pageText(page),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: ocrReviews.id });
  return rows.length;
}

export interface OcrReview {
  id: string;
  documentId: string;
  title: string;
  documentVersion: number;
  page: number;
  confidence: number;
  status: OcrReviewStatus;
  ocrText: string;
  correctedText: string | null;
  reviewerId: string | null;
  reviewedAt: Date | null;
}

interface ReviewRow extends Record<string, unknown> {
  id: string;
  document_id: string;
  title: string;
  document_version: number;
  page: number;
  confidence: number;
  status: OcrReviewStatus;
  ocr_text: string;
  corrected_text: string | null;
  reviewer_id: string | null;
  reviewed_at: string | Date | null;
}

const toReview = (row: ReviewRow): OcrReview => ({
  id: row.id,
  documentId: row.document_id,
  title: row.title,
  documentVersion: Number(row.document_version),
  page: Number(row.page),
  confidence: Number(row.confidence),
  status: row.status,
  ocrText: row.ocr_text,
  correctedText: row.corrected_text,
  reviewerId: row.reviewer_id,
  reviewedAt: row.reviewed_at === null ? null : new Date(row.reviewed_at),
});

/** `readable` uses the aliases `acl_*`; these use `r` and `doc`. */
const reviewSelect = sql`
  SELECT r.id, r.document_id, doc.title, r.document_version, r.page, r.confidence, r.status, r.ocr_text,
    r.corrected_text, r.reviewer_id, r.reviewed_at
  FROM ocr_reviews r JOIN documents doc ON doc.id = r.document_id AND doc.version = r.document_version`;

/**
 * The reviews of the documents' current versions that the user may read, lowest confidence first. Run it inside
 * `withTenant` for the viewer's tenant.
 */
export async function listOcrReviews(
  tx: Tx,
  userId: string,
  options: { status?: OcrReviewStatus; limit?: number } = {},
): Promise<OcrReview[]> {
  const rows = await tx.execute<ReviewRow>(sql`
    ${reviewSelect}
    WHERE r.status = ${options.status ?? "pending"} AND ${readable(userId, sql`doc.id`)}
    ORDER BY r.confidence, doc.title, r.page
    LIMIT ${options.limit ?? 100}`);
  return rows.map(toReview);
}

/** One review the user may read, at its document's current version, locked when `forUpdate`. */
async function findReview(tx: Tx, userId: string, reviewId: string, forUpdate = false): Promise<OcrReview | null> {
  const [row] = await tx.execute<ReviewRow>(sql`
    ${reviewSelect}
    WHERE r.id = ${reviewId} AND ${readable(userId, sql`doc.id`)}
    ${forUpdate ? sql`FOR UPDATE OF r` : sql``}`);
  return row ? toReview(row) : null;
}

/** The review was decided already, or its document has moved on to a new version. */
export class ReviewConflictError extends Error {
  override name = "ReviewConflictError";
}

/** The reviewer says OCR read the page right. Null when the user can't see the review. */
export async function acceptOcrReview(tx: Tx, reviewerId: string, reviewId: string): Promise<OcrReview | null> {
  const review = await findReview(tx, reviewerId, reviewId, true);
  if (!review) return null;
  if (review.status !== "pending") throw new ReviewConflictError(`the review is already ${review.status}`);
  await tx.execute(sql`
    UPDATE ocr_reviews SET status = 'accepted', reviewer_id = ${reviewerId}, reviewed_at = now(), updated_at = now()
    WHERE id = ${reviewId}`);
  return findReview(tx, reviewerId, reviewId);
}

export interface CorrectionDeps {
  withTenant: <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;
  embedder: Embedder;
  /** For a neighbour page that has no review row: its text layer, or OCR when it has none. */
  parseDeps: ParseDeps;
}

export interface Correction {
  review: OcrReview;
  /** The pages whose chunks were cut again: the corrected one, plus any a replaced chunk ran into. */
  pages: { from: number; to: number };
  removed: number;
  added: number;
}

/** A chunk's place: its id, its order in the document and the pages it holds. */
export type SpanChunk = {
  id: string;
  ordinal: number;
  page_start: number;
  page_end: number;
};

/**
 * The pages to cut again and the chunks they replace. A chunk can run across a page break, so the span is the
 * pages the chunks holding `page` reach, and every chunk inside the span goes. A chunk that crosses into the span
 * from outside stays: it keeps its copy of a few sentences of an edge page, as overlap does, and nothing is lost.
 */
export function spanToRecut(all: readonly SpanChunk[], page: number): { from: number; to: number; ids: string[] } {
  const holding = all.filter((c) => c.page_start <= page && c.page_end >= page);
  const from = Math.min(page, ...holding.map((c) => c.page_start));
  const to = Math.max(page, ...holding.map((c) => c.page_end));
  return { from, to, ids: all.filter((c) => c.page_start >= from && c.page_end <= to).map((c) => c.id) };
}

/**
 * The reviewer's text replaces what OCR read. Three phases, so no transaction stays open across the parse or the
 * embedder: read the review, the chunks around the page and the stored bytes; cut the span again and embed the new
 * chunks; then, in one transaction, check nothing moved, swap the chunks and mark the review corrected.
 */
export async function correctOcrReview(
  deps: CorrectionDeps,
  viewer: { tenantId: string; userId: string },
  reviewId: string,
  correctedText: string,
): Promise<Correction | null> {
  const text = correctedText.trim();
  if (text === "") throw new RangeError("the corrected text is empty");

  const read = await deps.withTenant(viewer.tenantId, async (tx) => {
    const review = await findReview(tx, viewer.userId, reviewId);
    if (!review) return null;
    if (review.status !== "pending") throw new ReviewConflictError(`the review is already ${review.status}`);
    const all = await tx.execute<SpanChunk>(sql`
      SELECT id, ordinal, page_start, page_end FROM chunks
      WHERE document_id = ${review.documentId} AND document_version = ${review.documentVersion}
        AND page_start IS NOT NULL
      ORDER BY ordinal`);
    const span = spanToRecut(all, review.page);
    const others = await tx.execute<{ page: number; text: string }>(sql`
      SELECT page, coalesce(corrected_text, ocr_text) AS text FROM ocr_reviews
      WHERE document_id = ${review.documentId} AND document_version = ${review.documentVersion}
        AND page BETWEEN ${span.from} AND ${span.to} AND id <> ${reviewId}`);
    const [blob] = await tx.execute<{ bytes: Buffer; mime_type: string }>(sql`
      SELECT b.bytes, b.mime_type FROM documents doc JOIN document_blobs b ON b.sha256 = doc.storage_key
      WHERE doc.id = ${review.documentId}`);
    if (!blob) throw new Error(`document ${review.documentId} has no stored blob`);
    return { review, span, all, known: new Map(others.map((row) => [Number(row.page), row.text])), blob };
  });
  if (!read) return null;
  const { review, span, all, known, blob } = read;

  // The span's pages: the corrected text, other reviewed pages as their reviews hold them, the rest parsed again.
  known.set(review.page, text);
  const pages: Page[] = [];
  for (let number = span.from; number <= span.to; number++) {
    const stored = known.get(number);
    if (stored !== undefined) {
      pages.push({ number, blocks: ocrBlocks(stored), method: "ocr" });
    } else {
      const parsed = await parse(new Uint8Array(blob.bytes), PDF, deps.parseDeps, {
        pages: { from: number, to: number },
      });
      pages.push(...(parsed.pages ?? []));
    }
  }
  const pieces: Chunk[] = chunk({ mimeType: PDF, pages, blocks: pages.flatMap((page) => page.blocks) });
  const vectors = pieces.length ? await deps.embedder.embed(pieces.map((piece) => piece.text)) : [];

  return deps.withTenant(viewer.tenantId, async (tx) => {
    const locked = await findReview(tx, viewer.userId, reviewId, true);
    if (!locked || locked.status !== "pending" || locked.documentVersion !== review.documentVersion) {
      throw new ReviewConflictError("the review or its document changed while the page was being cut again");
    }
    const replaced = all.filter((c) => span.ids.includes(c.id));
    const deleted = span.ids.length
      ? await tx.execute(sql`DELETE FROM chunks WHERE id = ANY(${uuidArray(span.ids)}) RETURNING id`)
      : [];
    if (deleted.length !== span.ids.length) throw new ReviewConflictError("the page's chunks changed meanwhile");

    const base = replaced.length
      ? Math.min(...replaced.map((c) => c.ordinal))
      : Math.max(-1, ...all.filter((c) => c.page_end < span.from).map((c) => c.ordinal)) + 1;
    await makeRoom(tx, review, base, pieces.length);
    if (pieces.length) {
      await tx.insert(chunks).values(
        pieces.map((piece, i) => ({
          tenantId: viewer.tenantId,
          documentId: review.documentId,
          documentVersion: review.documentVersion,
          ordinal: base + i,
          text: piece.text,
          pageStart: piece.pageStart,
          pageEnd: piece.pageEnd,
          section: piece.section,
          tokenCount: piece.tokenCount,
          embedding: vectors[i],
          embeddingModelVersion: deps.embedder.version,
        })),
      );
    }
    await tx.execute(sql`
      UPDATE ocr_reviews SET status = 'corrected', corrected_text = ${text}, reviewer_id = ${viewer.userId},
        reviewed_at = now(), updated_at = now()
      WHERE id = ${reviewId}`);
    return {
      review: (await findReview(tx, viewer.userId, reviewId))!,
      pages: { from: span.from, to: span.to },
      removed: deleted.length,
      added: pieces.length,
    };
  });
}

/**
 * Frees the ordinals `base` to `base + count - 1` for the new chunks, moving the chunks after them on as far as
 * needed. Ordinals are unique per version and checked row by row, so the move goes through negative numbers.
 */
async function makeRoom(tx: Tx, review: OcrReview, base: number, count: number): Promise<void> {
  const [{ next }] = await tx.execute<{ next: number | null }>(sql`
    SELECT min(ordinal) AS next FROM chunks
    WHERE document_id = ${review.documentId} AND document_version = ${review.documentVersion}
      AND ordinal >= ${base}`);
  const shift = next === null ? 0 : base + count - Number(next);
  if (shift <= 0) return;
  const scope = sql`document_id = ${review.documentId} AND document_version = ${review.documentVersion}`;
  await tx.execute(sql`UPDATE chunks SET ordinal = -(ordinal + ${shift}) WHERE ${scope} AND ordinal >= ${base}`);
  await tx.execute(sql`UPDATE chunks SET ordinal = -ordinal WHERE ${scope} AND ordinal < 0`);
}
