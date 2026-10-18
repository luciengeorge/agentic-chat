// 👨‍💼 One bit per dimension makes Kestrel's vector index 16 times smaller, small enough to stay in memory as the
//    corpus grows. But a bit string throws away almost everything a vector knew, so search on bits alone misses a
//    third of the true neighbours. This file wins most of them back.

import type { Tx } from "@/db/tenant";

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
 * The k nearest by cosine distance, found through a `bit` HNSW index: `overfetch` candidates by Hamming distance,
 * then the best k of those by their full vectors.
 */
export async function binaryRescoreNearest(tx: Tx, query: RescoreQuery): Promise<string[]> {
  // 🐨 Check the query: `embedding` has `dimensions` numbers, and `overfetch` is at least `k` (RangeError if not).
  // 🐨 Let the HNSW scan hand back `overfetch` rows: set `hnsw.ef_search` to at least `overfetch` (and at least
  //    `query.efSearch`), and switch sequential scans off for the transaction so the bit index is used.
  // 🐨 Then one statement. A MATERIALIZED CTE takes `overfetch` candidates: the rows ordered by the Hamming
  //    distance from `bitsColumn` to the question's bits, with each candidate's full vector. Outside it, sort those
  //    candidates by the cosine distance from their full vector to the question's, and keep `k` ids.
  //
  // 💰 Add `import { sql } from "drizzle-orm"`, `setEfSearch` from "#learn/vectors/hnsw", and `identifier` and
  //    `vectorLiteral` from "#learn/vectors/sql". `<~>` is Hamming distance between bit strings; the question's
  //    bits are a literal, `B'${binaryQuantize(embedding)}'`. `'${vectorLiteral(v)}'::vector(1536)` is the full
  //    question. `tx.execute<{ id: string }>(sql.raw(...))`, with names through `identifier`, and `id::text AS id`.
  //
  // 🦉 Why bits find candidates at all. A bit says only which side of zero each number sits on. Two vectors that
  //    point the same way agree on most signs, so few bits differ: Hamming distance is a coarse cosine. Coarse
  //    means ties: of the 1,536 bits, many chunks differ from the question in nearly the same number of places, and
  //    which of them come first is close to chance. That's why bits alone find 68% of the true top 10.
  // 🦉 Why rescoring wins it back. The true neighbours are nearly always somewhere near the top by Hamming, just
  //    not in the right order. Take 200 candidates instead of 10 and the right ones are among them; sort those 200
  //    by their exact cosine (reading the full vectors of 200 rows, not 5,637) and the top 10 is nearly the true
  //    one: 91.7% on the full corpus, from a 2.7 MB index.
  // 🦉 Why ef_search, the classic mistake. An HNSW scan hands back at most `ef_search` rows (40 by default). Ask
  //    for 200 candidates without raising it and you get 40, and the over-fetch you think you're paying for never
  //    happens.
  // 🦉 Why MATERIALIZED. It makes Postgres finish the candidate list before the outer sort, instead of folding
  //    the two ORDER BYs into one plan that skips the bit index.
  // 🦉 New in this file, already written: `binaryQuantize` (1 where a number is above zero, as pgvector's
  //    `binary_quantize` does) and `hammingDistance`, to try by hand.
  //
  // 📜 https://github.com/pgvector/pgvector#binary-quantization
  //
  // 🚨 The tests check that over-fetching every row gives exactly the exact answer for every golden question,
  //    that asking for 200 candidates gets 200, that rescoring 200 finds more than bits alone, and that an
  //    over-fetch below k is refused.
  throw new Error(
    `binaryRescoreNearest(${typeof tx}, ${query.table}.${query.bitsColumn}, k ${query.k}, ` +
      `over-fetch ${query.overfetch}) isn't written yet`,
  );
}
