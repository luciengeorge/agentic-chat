import { sql } from "drizzle-orm";

import type { Embedder } from "#learn/embed/embed";

import { DEFAULT_BATCH_SIZE } from "#learn/embed/embed";
import { uuidArray } from "#learn/search/sql";

import type { Tx } from "./tenant";

export interface EmbedScope {
  tenantId: string;
  /** One document's chunks, or every chunk of the tenant. */
  documentId?: string;
  /** Only chunks of this document version. */
  documentVersion?: number;
  batchSize?: number;
}

export interface EmbedResult {
  chunks: number;
  /** The tokens of the text sent to the embedder, by our tokenizer's count. */
  tokens: number;
  batches: number;
}

/**
 * Embeds the chunks in scope that have no embedding from `embedder.version` yet: never embedded, or embedded by
 * another model. One batch at a time, each written in its own transaction, so a retry after a failure picks up
 * where it stopped and pays only for what's left. The embedder runs outside the transaction.
 */
export async function embedPendingChunks(
  withTenant: <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>,
  embedder: Embedder,
  scope: EmbedScope,
): Promise<EmbedResult> {
  const { tenantId, documentId, documentVersion, batchSize = DEFAULT_BATCH_SIZE } = scope;
  const result: EmbedResult = { chunks: 0, tokens: 0, batches: 0 };
  // Rows a batch already tried are skipped by id, so a chunk the writer can't update can't loop forever.
  let after = "00000000-0000-0000-0000-000000000000";

  for (;;) {
    const pending = await withTenant(tenantId, (tx) =>
      tx.execute<{ id: string; text: string; tokens: number }>(sql`
        SELECT id, text, token_count AS tokens FROM chunks
        WHERE (embedding IS NULL OR embedding_model_version IS DISTINCT FROM ${embedder.version})
          AND id > ${after}::uuid
          ${documentId ? sql`AND document_id = ${documentId}` : sql``}
          ${documentVersion === undefined ? sql`` : sql`AND document_version = ${documentVersion}`}
        ORDER BY id
        LIMIT ${batchSize}`),
    );
    if (pending.length === 0) return result;

    const vectors = await embedder.embed(pending.map((row) => row.text));
    await withTenant(tenantId, (tx) =>
      tx.execute(sql`
        UPDATE chunks c
        SET embedding = v.embedding::vector, embedding_model_version = ${embedder.version}
        FROM unnest(
          ${uuidArray(pending.map((row) => row.id))},
          ARRAY[${sql.join(
            vectors.map((vector) => sql`${JSON.stringify(vector)}`),
            sql`, `,
          )}]::text[]
        ) AS v(id, embedding)
        WHERE c.id = v.id`),
    );
    result.chunks += pending.length;
    result.tokens += pending.reduce((sum, row) => sum + Number(row.tokens), 0);
    result.batches += 1;
    after = pending.at(-1)!.id;
  }
}
