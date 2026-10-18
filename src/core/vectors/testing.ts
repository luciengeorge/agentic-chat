import { v5 as uuidv5 } from "uuid";

import type { Db } from "@/db/create";

import { chunks, documents } from "@/db/schema";

import { RECORDED_MODEL, type RecordedChunk, recordedChunks } from "./recording";

export interface LoadedCorpus {
  /** Organization ids by slug. */
  tenants: Record<RecordedChunk["tenant"], string>;
  /** Document ids by path. */
  documentIds: Map<string, string>;
  /** Chunk ids by recording key (`<path>#<ordinal>`), and back. */
  chunkIds: Map<string, string>;
  keys: Map<string, string>;
}

/**
 * The recorded chunks as the app's own rows, in a migrated test database: both tenants, one ready document per
 * path, every chunk with its real embedding. The migrations' HNSW and BM25 indexes take them in as they go in.
 * Run it as the owner (`t.db`), which RLS doesn't bind.
 */
// Ids derive from the recording's keys, so every test database gives the same chunk the same id, and a search
// that breaks a score tie by id (as lexical and vector search do) orders it the same way every run.
const NAMESPACE = "3f6c2a9e-8b1d-4c57-a0e4-7d2b9c1f5e83";
const stableId = (key: string) => uuidv5(key, NAMESPACE);

export async function loadRecordedCorpus(db: Db, list: RecordedChunk[] = recordedChunks()): Promise<LoadedCorpus> {
  const rows = await db.$client<{ id: string; slug: RecordedChunk["tenant"] }[]>`
    INSERT INTO organization (name, slug, created_at)
    VALUES ('Kestrel Pay', 'kestrel', now()), ('Harbour Health', 'harbour', now())
    RETURNING id, slug`;
  const tenants = Object.fromEntries(rows.map((row) => [row.slug, row.id])) as LoadedCorpus["tenants"];

  const documentIds = new Map<string, string>();
  for (const chunk of list) {
    if (documentIds.has(chunk.path)) continue;
    const id = stableId(`document:${chunk.path}`);
    documentIds.set(chunk.path, id);
    await db.insert(documents).values({
      id,
      tenantId: tenants[chunk.tenant],
      source: "recording",
      externalId: chunk.path,
      title: chunk.title,
      path: chunk.path,
      mimeType: chunk.mimeType,
      version: 1,
      sourceVersion: "1",
      contentHash: chunk.path,
      status: "ready",
    });
  }

  const chunkIds = new Map<string, string>();
  const keys = new Map<string, string>();
  for (let i = 0; i < list.length; i += 100) {
    const batch = list.slice(i, i + 100).map((chunk) => {
      const id = stableId(`chunk:${chunk.key}`);
      chunkIds.set(chunk.key, id);
      keys.set(id, chunk.key);
      return {
        id,
        tenantId: tenants[chunk.tenant],
        documentId: documentIds.get(chunk.path)!,
        documentVersion: 1,
        ordinal: chunk.ordinal,
        text: chunk.text,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        section: chunk.section,
        tokenCount: chunk.tokenCount,
        embedding: chunk.embedding,
        embeddingModelVersion: RECORDED_MODEL,
      };
    });
    await db.insert(chunks).values(batch);
  }
  await db.$client`ANALYZE chunks`;
  return { tenants, documentIds, chunkIds, keys };
}

/** The document ids of one tenant's recorded chunks. */
export function tenantDocuments(corpus: LoadedCorpus, tenant: RecordedChunk["tenant"]): string[] {
  const paths = new Set(
    recordedChunks()
      .filter((c) => c.tenant === tenant)
      .map((c) => c.path),
  );
  return [...paths].map((path) => corpus.documentIds.get(path)!).filter(Boolean);
}
