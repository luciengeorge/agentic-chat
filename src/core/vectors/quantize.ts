import { sql } from "drizzle-orm";

import type { Tx } from "@/db/tenant";

import { setEfSearch } from "./hnsw";
import { identifier, vectorLiteral } from "./sql";

/**
 * Binary quantisation: one bit per dimension, 1 where the value is above zero (pgvector's `binary_quantize`).
 * 1,536 floats of 4 bytes become 192 bytes, 32 times smaller. Distance between two bit strings is the Hamming
 * distance: how many bits differ.
 */
export function binaryQuantize(embedding: readonly number[]): string {
  return embedding.map((value) => (value > 0 ? "1" : "0")).join("");
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new RangeError(`lengths differ: ${a.length} and ${b.length}`);
  let distance = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) distance++;
  return distance;
}

export interface RescoreQuery {
  table: string;
  /** A `bit(d)` column with an HNSW `bit_hamming_ops` index. */
  bitsColumn: string;
  /** The full `vector(d)` column, read only for the candidates. */
  vectorColumn: string;
  dimensions: number;
  embedding: readonly number[];
  k: number;
  /** Candidates taken by Hamming distance before rescoring: more costs more, finds more. */
  overfetch: number;
  efSearch: number;
}

/**
 * Bits find candidates, full vectors pick the answer. Bits are coarse (many vectors tie on Hamming distance), so
 * the search over-fetches `overfetch` candidates from the bit index, then sorts those by their exact cosine
 * distance and keeps k. The index stays small; the full vectors are read for a few dozen rows only.
 */
export async function binaryRescoreNearest(tx: Tx, query: RescoreQuery): Promise<string[]> {
  const { table, bitsColumn, vectorColumn, dimensions, embedding, k, overfetch } = query;
  if (embedding.length !== dimensions)
    throw new RangeError(`expected ${dimensions} dimensions, got ${embedding.length}`);
  if (overfetch < k) throw new RangeError(`overfetch ${overfetch} is below k ${k}`);
  await setEfSearch(tx, Math.max(query.efSearch, overfetch));
  await tx.execute(sql`SET LOCAL enable_seqscan = off`);
  const rows = await tx.execute<{ id: string }>(
    sql.raw(`
      WITH candidates AS MATERIALIZED (
        SELECT id, ${identifier(vectorColumn)} AS full_vector
        FROM ${identifier(table)}
        ORDER BY ${identifier(bitsColumn)} <~> B'${binaryQuantize(embedding)}'
        LIMIT ${overfetch}
      )
      SELECT id::text AS id FROM candidates
      ORDER BY full_vector <=> '${vectorLiteral(embedding)}'::vector(${dimensions})
      LIMIT ${k}`),
  );
  return rows.map((row) => row.id);
}
