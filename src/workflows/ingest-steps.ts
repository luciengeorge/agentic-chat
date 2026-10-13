import { and, eq, gte, lt, ne, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { FatalError, RetryableError } from "workflow";

import { chunk } from "#learn/chunk/chunk";
import { parse, PDF, pdfPageCount, UnsupportedDocumentError } from "#learn/parse/parse";
import { chunks, documentBlobs, documents } from "@/db/schema";
import { type Tx, withTenant } from "@/db/tenant";
import { createLogger } from "@/lib/logger";

import { ORDINALS_PER_RANGE, PageRouteError, pageRouteDeps } from "./ingest-deps";
import { asStep, graphFor } from "./sync-common";

const logger = createLogger("workflows.ingest");

export type Skip = "missing" | "deleted" | "superseded";

/** The document at this version, locked, or why the run should leave it alone. */
async function current(tx: Tx, documentId: string, version: number) {
  const [document] = await tx.select().from(documents).where(eq(documents.id, documentId)).for("update");
  if (!document) return { skip: "missing" as Skip };
  if (document.status === "deleted") return { skip: "deleted" as Skip };
  // A newer sync bumped the version: its own run ingests that one.
  if (document.version !== version) return { skip: "superseded" as Skip };
  return { document };
}

/** Marks the document as being ingested, unless it's gone or a newer version replaced it. */
export async function startIngest(tenantId: string, documentId: string, version: number) {
  "use step";
  return withTenant(tenantId, async (tx) => {
    const { document, skip } = await current(tx, documentId, version);
    if (skip) return { skip };
    await tx.update(documents).set({ status: "ingesting" }).where(eq(documents.id, document!.id));
    return { skip: null };
  });
}
startIngest.maxRetries = 3;

/**
 * Downloads the file and stores its bytes in `document_blobs`, content-addressed by sha256, which becomes the
 * document's `storage_key`. Returns the page count for a PDF, so the run can decide whether to fan out.
 */
export async function storeBlob(tenantId: string, documentId: string, version: number) {
  "use step";
  return asStep(async () => {
    const found = await withTenant(tenantId, (tx) => current(tx, documentId, version));
    if (found.skip) return { skip: found.skip, pages: null };
    const { externalId, mimeType } = found.document!;
    const { bytes } = await (await graphFor(tenantId)).content(externalId);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let pages: number | null = null;
    if (mimeType === PDF) {
      try {
        pages = await pdfPageCount(bytes);
      } catch (error) {
        throw new FatalError(`not a readable PDF: ${(error as Error).message}`);
      }
    }
    await withTenant(tenantId, async (tx) => {
      await tx
        .insert(documentBlobs)
        .values({ tenantId, sha256, bytes: Buffer.from(bytes), size: bytes.length, mimeType })
        .onConflictDoNothing();
      await tx
        .update(documents)
        .set({ storageKey: sha256 })
        .where(and(eq(documents.id, documentId), eq(documents.version, version)));
    });
    return { skip: null, sha256, size: bytes.length, pages };
  });
}
storeBlob.maxRetries = 5;

/**
 * Parses the stored bytes (a page range of a PDF, or the whole document), chunks them, and writes the chunks for
 * this version, replacing what an earlier attempt wrote. Embeddings come later (wave 2).
 */
export async function parseAndChunk(
  tenantId: string,
  documentId: string,
  version: number,
  range: { from: number; to: number } | null,
  index: number,
) {
  "use step";
  const loaded = await withTenant(tenantId, async (tx) => {
    const found = await current(tx, documentId, version);
    if (found.skip) return null;
    const [blob] = await tx
      .select({ bytes: documentBlobs.bytes, mimeType: documentBlobs.mimeType })
      .from(documentBlobs)
      .where(eq(documentBlobs.sha256, found.document!.storageKey ?? ""));
    if (!blob) throw new Error(`document ${documentId} has no stored blob`);
    return blob;
  });
  if (!loaded) return { chunks: 0, skipped: true };

  let parsed;
  try {
    parsed = await parse(new Uint8Array(loaded.bytes), loaded.mimeType, pageRouteDeps, range ? { pages: range } : {});
  } catch (error) {
    if (error instanceof PageRouteError) throw new RetryableError(error.message, { retryAfter: 2_000 });
    if (error instanceof FatalError) throw error;
    // The bytes themselves can't be parsed (UnsupportedDocumentError, RangeError, a broken file): no retry helps.
    const kind = error instanceof UnsupportedDocumentError ? "unsupported" : "unparseable";
    throw new FatalError(`${kind}: ${(error as Error).message}`);
  }
  const pieces = chunk(parsed);
  const base = index * ORDINALS_PER_RANGE;
  if (pieces.length >= ORDINALS_PER_RANGE) throw new FatalError(`${pieces.length} chunks overflow a page range`);

  const written = await withTenant(tenantId, async (tx) => {
    const found = await current(tx, documentId, version);
    if (found.skip) return null;
    await tx
      .delete(chunks)
      .where(
        and(
          eq(chunks.documentId, documentId),
          eq(chunks.documentVersion, version),
          gte(chunks.ordinal, base),
          lt(chunks.ordinal, base + ORDINALS_PER_RANGE),
        ),
      );
    for (let i = 0; i < pieces.length; i += 500) {
      await tx.insert(chunks).values(
        pieces.slice(i, i + 500).map((piece) => ({
          tenantId,
          documentId,
          documentVersion: version,
          ordinal: base + piece.ordinal,
          text: piece.text,
          pageStart: piece.pageStart,
          pageEnd: piece.pageEnd,
          section: piece.section,
          tokenCount: piece.tokenCount,
        })),
      );
    }
    return pieces.length;
  });
  const ocrPages = parsed.pages?.filter((page) => page.method === "ocr").length ?? 0;
  logger.info("parsed and chunked", { documentId, version, range, chunks: written, ocrPages });
  return { chunks: written ?? 0, skipped: written === null, ocrPages };
}
parseAndChunk.maxRetries = 3;

/** Marks the version ready and drops older versions' chunks, unless a newer version or a delete overtook it. */
export async function finishIngest(tenantId: string, documentId: string, version: number) {
  "use step";
  return withTenant(tenantId, async (tx) => {
    const found = await current(tx, documentId, version);
    if (found.skip) return { status: found.skip, chunks: 0 };
    await tx.delete(chunks).where(and(eq(chunks.documentId, documentId), ne(chunks.documentVersion, version)));
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(chunks)
      .where(eq(chunks.documentId, documentId));
    await tx.update(documents).set({ status: "ready" }).where(eq(documents.id, documentId));
    return { status: "ready" as const, chunks: n };
  });
}
finishIngest.maxRetries = 3;

export async function failIngest(tenantId: string, documentId: string, version: number, reason: string) {
  "use step";
  logger.error("ingest failed", { documentId, version, reason });
  await withTenant(tenantId, async (tx) => {
    const found = await current(tx, documentId, version);
    if (!found.skip) await tx.update(documents).set({ status: "failed" }).where(eq(documents.id, documentId));
  });
}
failIngest.maxRetries = 3;
