// 👨‍💼 This is the vector half of every search the assistant runs. The HNSW index holds every tenant's chunks, and
//    the viewer may read only some of them, so the search has to find the nearest chunks the viewer may see, not
//    the nearest chunks in the building.

import type { Hit } from "#learn/search/lexical";
import type { Tx } from "@/db/tenant";

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
 * The `limit` nearest chunks by cosine distance over the HNSW index (`chunks_embedding_hnsw_idx`), among chunks of
 * `documentIds` (the ACL pre-filter) made by `modelVersion`, best first. `score` is the cosine similarity.
 */
export async function vectorSearch(tx: Tx, embedding: number[], options: VectorSearchOptions): Promise<Hit[]> {
  if (options.documentIds.length === 0) return [];
  // 🐨 Set `hnsw.ef_search` for this transaction: `options.efSearch` (or DEFAULT_EF_SEARCH), and never below
  //    `options.limit`. Refuse anything above 1,000 with a RangeError.
  // 🐨 Turn on pgvector's iterative scan for this transaction, in its `relaxed_order` mode.
  // 🐨 Then one query: the chunks of `documentIds` with `embedding_model_version` = `modelVersion`, ordered by
  //    cosine distance to the embedding, `limit` of them. Wrap it in a MATERIALIZED CTE and sort its rows again
  //    outside (by distance, then id). Return `{ id, score }` with score = 1 - distance.
  //
  // 💰 Add `import { sql } from "drizzle-orm"` and `import { uuidArray } from "#learn/search/sql"`.
  //    `tx.execute(sql.raw(text))` sends `text` as it is: Postgres's SET takes no parameters, so a number goes in
  //    as text (check it's a whole number first). pgvector's settings are `hnsw.ef_search` and
  //    `hnsw.iterative_scan` (its modes are in the 📜). `embedding <=> ${JSON.stringify(v)}::vector` is the cosine
  //    distance; `document_id = ANY(${uuidArray(ids)})` keeps to the list. pgvector returns distances as numbers
  //    or strings, so `Number(row.distance)`.
  //
  // 🦉 Why a filter breaks a plain HNSW scan. The index knows vectors, not tenants or ACLs. pgvector walks the
  //    graph, hands back its `ef_search` nearest, and only then does Postgres apply the WHERE clause and the
  //    tenant's RLS policy. When most of the nearest belong to someone else, they're all thrown away and the
  //    search returns fewer than `limit` rows, or none. A Harbour user asking about Kestrel's prices gets nothing,
  //    because the 158 chunks nearest the question are all Kestrel's.
  // 🦉 Why the iterative scan fixes it. With `hnsw.iterative_scan` on (pgvector 0.8), when the filter leaves too
  //    few rows, the scan keeps walking the graph outwards for more candidates until `limit` pass (or it reaches
  //    `hnsw.max_scan_tuples`). `relaxed_order` lets it hand them back slightly out of order, which is faster;
  //    that's why the rows are sorted again outside. MATERIALIZED stops the planner from merging the two
  //    queries back into one.
  // 🦉 Why ef_search is at least the limit. Without the iterative scan an HNSW scan returns at most `ef_search`
  //    rows, so `LIMIT 50` with `ef_search = 40` could never give 50. Even with it, the first pass should be
  //    able to fill the page.
  // 🦉 Why SET LOCAL, the classic mistake. Connections are pooled. A plain `SET` stays on the connection after the
  //    transaction ends, so the next request that borrows it inherits your settings. `SET LOCAL` ends with the
  //    transaction.
  //
  // 📜 https://github.com/pgvector/pgvector#iterative-index-scans
  //
  // 🚨 The tests check that the nearest chunks come back best first with the cosine similarity as their score,
  //    that only chunks of the listed documents and the given model version come back, that a Harbour user asking
  //    about Kestrel's KC-PRO-12 gets 10 Harbour chunks through the index, and that no setting outlives the
  //    transaction.
  throw new Error(
    `vectorSearch(${typeof tx}, ${embedding.length} dimensions, ${options.documentIds.length} documents, ` +
      `limit ${options.limit}) isn't written yet`,
  );
}
