// 👨‍💼 Every chunk's vector sits in one HNSW index, `chunks_embedding_hnsw_idx`, both tenants' together. How that
//    graph is built decides how much a search can find, and the build happens once, at migration time, where a
//    wrong knob is expensive to undo: rebuilding the index over the filing takes minutes and blocks writes.

import { sql } from "drizzle-orm";

import type { Db } from "@/db/create";
import type { Tx } from "@/db/tenant";

import { identifier, vectorLiteral } from "#learn/vectors/sql";

/**
 * HNSW (hierarchical navigable small world) is a graph: each vector links to its nearest neighbours, in layers
 * from sparse to dense. A search starts at the top, walks greedily towards the query, and drops a layer each time.
 * Three knobs set the trade:
 * - `m`: links per node. More links, better recall, a bigger index, a slower build.
 * - `ef_construction`: how many candidates the build weighs when it picks each node's links. Higher builds a
 *   better graph, slower. It must be at least 2 * m.
 * - `ef_search` (per query): how many candidates the search keeps. Higher finds more of the true neighbours,
 *   slower. pgvector returns at most `ef_search` rows from an HNSW scan, so it must be at least the LIMIT.
 */
export interface HnswKnobs {
  m: number;
  efConstruction: number;
}

/** pgvector's defaults, which the app's `chunks_embedding_hnsw_idx` uses. */
export const PGVECTOR_DEFAULTS: HnswKnobs = { m: 16, efConstruction: 64 };
export const DEFAULT_EF_SEARCH = 40;

/** The operator class decides the distance: cosine for full and half-precision vectors, Hamming for bits. */
export type VectorOps = "vector_cosine_ops" | "halfvec_cosine_ops" | "bit_hamming_ops";

export interface HnswIndex {
  name: string;
  table: string;
  column: string;
  ops: VectorOps;
  knobs: HnswKnobs;
}

export function hnswIndexSql({ name, table, column, ops, knobs }: HnswIndex): string {
  // 🐨 Check the knobs first, and throw a RangeError for any pgvector can't build a sound graph from: `m` a whole
  //    number from 2 to 100, `efConstruction` a whole number from 2 × m to 1,000.
  // 🐨 Then write the statement: create the index `name` on `table`, using hnsw, over `column` with the operator
  //    class `ops`, and the two knobs in a WITH clause. Pass every name through `identifier` (it refuses anything
  //    that would need quoting), so nothing odd ever reaches the SQL.
  //
  // 💰 `CREATE INDEX i ON t USING hnsw (c vector_cosine_ops) WITH (m = 16, ef_construction = 64)`.
  //
  // 🦉 What the graph is. Every vector is a node, linked to up to `m` of its nearest neighbours (2 × m on the
  //    bottom layer). A few nodes are also copied to sparser layers above. A search starts at the top, where hops
  //    are long, walks greedily to whichever neighbour is closer to the question, drops a layer, and repeats, so it
  //    reaches the right neighbourhood after comparing the question with a small share of the vectors.
  // 🦉 Why `m` costs and pays. More links per node give the walk more ways round a dead end, so it misses fewer
  //    true neighbours; each link is also more to store and more to compare at every hop. On the full corpus, at
  //    ef_search 40, m 4 finds 35.9% of the true top 10, m 16 75.9% and m 32 87.4% (the bench).
  // 🦉 Why ef_construction is at least 2 × m. While it inserts a node, the build keeps a list of `ef_construction`
  //    candidates and picks the `m` links from them. With fewer candidates than links to choose (and 2 × m on the
  //    bottom layer), it would link to whatever it happened to find first.
  // 🦉 New in this file, already written: `buildHnswIndex` (drops an index of the same name, builds yours, times
  //    it), `setEfSearch`, `annNearest` and `nearest`, which the next step uses.
  //
  // 📜 https://github.com/pgvector/pgvector#hnsw
  //
  // 🚨 The tests check the statement for a cosine and a Hamming index, that bad knobs are refused before any SQL
  //    is written, and that a build over the recorded chunks stores m and ef_construction on the index.
  throw new Error(`hnswIndexSql(${name} on ${table}.${column}, ${ops}, m ${knobs.m}) isn't written yet`);
}

/** Builds an HNSW index with these knobs (dropping one of the same name first) and says how long it took. */
export async function buildHnswIndex(db: Db, index: HnswIndex): Promise<{ ms: number }> {
  const ddl = hnswIndexSql(index);
  await db.execute(sql.raw(`DROP INDEX IF EXISTS ${identifier(index.name)}`));
  const started = performance.now();
  await db.execute(sql.raw(ddl));
  return { ms: performance.now() - started };
}

/** `hnsw.ef_search` for the rest of the transaction. */
export async function setEfSearch(tx: Tx, efSearch: number): Promise<void> {
  if (!Number.isInteger(efSearch) || efSearch < 1 || efSearch > 1000) {
    throw new RangeError(`ef_search must be 1 to 1000, got ${efSearch}`);
  }
  await tx.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${efSearch}`));
}

export interface NearestQuery {
  table: string;
  column: string;
  /** `vector` or `halfvec`: the query is cast to the column's type, so the index's operator applies. */
  type: "vector" | "halfvec";
  dimensions: number;
  embedding: readonly number[];
  k: number;
}

/**
 * The k nearest ids by cosine distance, through the HNSW index: approximate nearest neighbours (ANN). Sequential
 * scans are switched off for the transaction, so the planner can't sort the table instead, as it would on a small
 * one.
 */
export async function annNearest(tx: Tx, query: NearestQuery & { efSearch: number }): Promise<string[]> {
  await setEfSearch(tx, query.efSearch);
  await tx.execute(sql`SET LOCAL enable_seqscan = off`);
  return nearest(tx, query);
}

/** The shared query: `ORDER BY column <=> query LIMIT k`. Whether it's exact depends on the plan. */
export async function nearest(tx: Tx, query: NearestQuery): Promise<string[]> {
  const { table, column, type, dimensions, embedding, k } = query;
  if (embedding.length !== dimensions)
    throw new RangeError(`expected ${dimensions} dimensions, got ${embedding.length}`);
  const rows = await tx.execute<{ id: string }>(
    sql.raw(
      `SELECT id::text AS id FROM ${identifier(table)} ` +
        `ORDER BY ${identifier(column)} <=> '${vectorLiteral(embedding)}'::${type}(${dimensions}) LIMIT ${k}`,
    ),
  );
  return rows.map((row) => row.id);
}
