import { sql } from "drizzle-orm";

import type { Hit } from "#learn/search/lexical";
import type { Tx } from "@/db/tenant";

import { uuidArray } from "#learn/search/sql";

export interface VectorSearchOptions {
  documentIds: readonly string[];
  /** Only vectors of this `embedding_model_version` are comparable with the query's. */
  modelVersion: string;
  limit: number;
  /** HNSW's candidate list per query: higher finds more of the true neighbours, slower. */
  efSearch?: number;
}

export const DEFAULT_EF_SEARCH = 100;

/**
 * Nearest chunks by cosine distance over the HNSW index (`chunks_embedding_hnsw_idx`). The ACL pre-filter and the
 * tenant's RLS policy are WHERE clauses, which an HNSW scan applies after it walks the graph: with a plain scan a
 * selective filter returns fewer than `limit` rows. `hnsw.iterative_scan` keeps scanning until enough rows pass
 * (pgvector 0.8). `relaxed_order` may return them slightly out of order, so they're sorted again outside.
 *
 * `score` is the cosine similarity, 1 - distance. Both settings are `SET LOCAL`: they end with the transaction.
 */
export async function vectorSearch(tx: Tx, embedding: number[], options: VectorSearchOptions): Promise<Hit[]> {
  if (options.documentIds.length === 0) return [];
  const efSearch = Math.max(options.efSearch ?? DEFAULT_EF_SEARCH, options.limit);
  if (!Number.isInteger(efSearch) || efSearch > 1000) throw new RangeError(`ef_search out of range: ${efSearch}`);
  await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${efSearch}`));
  await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
  const vector = JSON.stringify(embedding);
  const rows = await tx.execute<{ id: string; distance: number }>(sql`
    WITH nearest AS MATERIALIZED (
      SELECT id, embedding <=> ${vector}::vector AS distance
      FROM chunks
      WHERE embedding_model_version = ${options.modelVersion}
        AND document_id = ANY(${uuidArray(options.documentIds)})
      ORDER BY embedding <=> ${vector}::vector
      LIMIT ${options.limit}
    )
    SELECT id, distance FROM nearest ORDER BY distance, id`);
  return rows.map((row) => ({ id: row.id, score: 1 - Number(row.distance) }));
}
