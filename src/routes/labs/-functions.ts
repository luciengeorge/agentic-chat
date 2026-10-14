import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { ParsedDocument } from "#learn/parse/types";

import { chunk } from "#learn/chunk/chunk";
import { countTokens } from "#learn/chunk/tokens";
import { parse, PDF } from "#learn/parse/parse";
import { readable } from "#learn/retrieve/acl";
import { repeats } from "@/components/labs/overlap";
import { withTenant } from "@/db/tenant";
import { scopeOf, viewerMiddleware } from "@/lib/middleware";
import { documentFile } from "@/routes/api/chat/-sources";

export interface LabDocument {
  id: string;
  title: string;
  mimeType: string;
  /** PDFs only: the last page ingestion found text on. */
  pages: number | null;
}

/** The ready documents the viewer may read, for the labs' document picker. Not `d`: `readable` uses that alias. */
export const getLabDocuments = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .handler(async ({ context }) => {
    const scope = scopeOf(context.viewer);
    return withTenant(scope.tenantId, async (tx) => {
      const rows = await tx.execute<{ id: string; title: string; mime_type: string; pages: number | null }>(sql`
        SELECT doc.id, doc.title, doc.mime_type,
          (SELECT max(c.page_end) FROM chunks c
           WHERE c.document_id = doc.id AND c.document_version = doc.version) AS pages
        FROM documents doc
        WHERE ${readable(scope.userId, sql`doc.id`)}
        ORDER BY doc.title`);
      return rows.map((row): LabDocument => ({
        id: row.id,
        title: row.title,
        mimeType: row.mime_type,
        pages: row.pages,
      }));
    });
  });

/** Parsed pages, so moving the sliders doesn't parse (or OCR) the page again. */
const parsedCache = new Map<string, ParsedDocument>();

async function parsedPage(bytes: Uint8Array, mimeType: string, key: string, page: number | null) {
  const hit = parsedCache.get(key);
  if (hit) return hit;
  const { rasterisePage } = await import("@/lib/parse/rasterise.server");
  const { ocrPng } = await import("@/lib/parse/ocr");
  const range = mimeType === PDF && page ? { pages: { from: page, to: page } } : {};
  const doc = await parse(bytes, mimeType, { rasterise: rasterisePage, ocr: ocrPng }, range);
  if (parsedCache.size >= 20) parsedCache.delete(parsedCache.keys().next().value!);
  parsedCache.set(key, doc);
  return doc;
}

/**
 * One page of a document (the whole document, for markdown and DOCX) cut by `#learn/chunk/chunk`: the
 * learner's code while a chunking step is active, the reference otherwise. An error from the chunker comes
 * back as `error`, so the lab can show it.
 */
export const getChunkedPage = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .validator(
    z.object({
      documentId: z.uuid(),
      page: z.number().int().min(1).nullable(),
      targetTokens: z.number().int().min(16).max(4096),
      overlapTokens: z.number().int().min(0).max(4095),
    }),
  )
  .handler(async ({ context, data }) => {
    const scope = scopeOf(context.viewer);
    const file = await withTenant(scope.tenantId, (tx) => documentFile(tx, scope, data.documentId));
    if (!file) throw new Error("No such document, or you can't read it.");
    const page = file.mimeType === PDF ? (data.page ?? 1) : null;
    const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(file.bytes))).toString("hex");
    const doc = await parsedPage(file.bytes, file.mimeType, `${digest}:${page}`, page);
    try {
      const chunks = chunk(doc, { targetTokens: data.targetTokens, overlapTokens: data.overlapTokens });
      return {
        page,
        error: null,
        chunks: chunks.map((c, i) => {
          const marks = repeats(chunks[i - 1]?.text ?? null, c.text);
          return {
            ordinal: c.ordinal,
            text: c.text,
            section: c.section,
            tokenCount: c.tokenCount,
            ...marks,
            overlapTokens: marks.overlap ? countTokens(c.text.slice(marks.header, marks.header + marks.overlap)) : 0,
          };
        }),
      };
    } catch (error) {
      return { page, error: (error as Error).message, chunks: [] };
    }
  });
