import { and, eq } from "drizzle-orm";

import type { Viewer } from "#learn/retrieve/types";
import type { Tx } from "@/db/tenant";

import { canRead } from "#learn/retrieve/acl";
import { chunks, documentBlobs, documents } from "@/db/schema";

export interface CitedChunk {
  chunkId: string;
  text: string;
  section: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  document: { id: string; title: string; path: string; mimeType: string };
}

/** A cited chunk with its document, if the viewer may read that document now. Null otherwise, and for a chunk a
 * re-ingest replaced: the caller can't tell "gone" from "not yours", which is the point. */
export async function citedChunk(tx: Tx, viewer: Viewer, chunkId: string): Promise<CitedChunk | null> {
  const [row] = await tx
    .select({
      chunkId: chunks.id,
      text: chunks.text,
      section: chunks.section,
      pageStart: chunks.pageStart,
      pageEnd: chunks.pageEnd,
      documentId: documents.id,
      title: documents.title,
      path: documents.path,
      mimeType: documents.mimeType,
    })
    .from(chunks)
    .innerJoin(documents, and(eq(documents.id, chunks.documentId), eq(documents.version, chunks.documentVersion)))
    .where(eq(chunks.id, chunkId));
  if (!row || !(await canRead(tx, viewer.userId, row.documentId))) return null;
  const { documentId, title, path, mimeType, ...chunk } = row;
  return { ...chunk, document: { id: documentId, title, path, mimeType } };
}

export interface DocumentFile {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}

/** A document's original bytes, if the viewer may read it. */
export async function documentFile(tx: Tx, viewer: Viewer, documentId: string): Promise<DocumentFile | null> {
  if (!(await canRead(tx, viewer.userId, documentId))) return null;
  const [row] = await tx
    .select({ bytes: documentBlobs.bytes, mimeType: documents.mimeType, path: documents.path })
    .from(documents)
    .innerJoin(documentBlobs, eq(documentBlobs.sha256, documents.storageKey))
    .where(eq(documents.id, documentId));
  if (!row) return null;
  return { bytes: row.bytes, mimeType: row.mimeType, filename: row.path.split("/").at(-1) ?? "document" };
}
