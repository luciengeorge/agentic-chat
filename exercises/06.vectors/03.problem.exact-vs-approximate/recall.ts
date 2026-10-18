// 👨‍💼 Kestrel's vector search runs on HNSW, which is fast because it doesn't look at every chunk. So it can miss
//    the chunk that answers the question, and nothing in its output says when it has. Before anyone tunes ef_search
//    or m, someone has to measure how much it misses, and that needs the true answer to compare with.

import type { NearestQuery } from "#learn/vectors/hnsw";
import type { Tx } from "@/db/tenant";

/** The exact k nearest ids: the ground truth the approximate search is measured against. */
export async function exactNearest(tx: Tx, query: NearestQuery): Promise<string[]> {
  // 🐨 Make sure this transaction can't answer from the HNSW index: switch index scans off for it, and bitmap
  //    scans too. Then run the shared nearest-neighbour query.
  //
  // 💰 Add `import { sql } from "drizzle-orm"` and `nearest` to the import from "#learn/vectors/hnsw".
  //    await tx.execute(sql`SET LOCAL enable_indexscan = off`), the same for enable_bitmapscan.
  //    `nearest(tx, query)` runs `ORDER BY <column> <=> <query> LIMIT k`.
  //
  // 🦉 Why switch the index off. `ORDER BY embedding <=> $1 LIMIT 10` doesn't say how to find the answer; the
  //    planner picks. With an HNSW index on the column it walks the graph whenever that looks cheaper, which on a
  //    big table is always. Your "truth" would then be the approximate answer, recall would come out 100%, and
  //    every tuning decision after it would rest on nothing. That's the classic mistake. With index scans off, the
  //    only plan left is a sequential scan: every row's distance computed, then sorted.
  // 🦉 What exact costs. A sequential scan reads all 5,637 vectors of the corpus, 6 KB each, for every question:
  //    18 ms against 1.6 ms for HNSW (the bench). Fine for measuring, too slow to serve every search with.
  //
  // 📜 https://www.postgresql.org/docs/current/runtime-config-query.html#RUNTIME-CONFIG-QUERY-ENABLE
  throw new Error(`exactNearest(${typeof tx}, ${query.table}.${query.column}, k ${query.k}) isn't written yet`);
}

/** recall@k: the share of the true k nearest that the approximate search found in its first k. */
export function recallAtK(found: readonly string[], truth: readonly string[], k: number): number {
  // 🐨 Take the first k of `truth` (the true neighbours; refuse an empty list with a RangeError) and the first k
  //    of `found`. Count how many of those true ids `found`'s first k holds, in any order, and divide by how many
  //    true ids there are.
  //
  // 💰 `list.slice(0, k)`, `new Set(ids).has(id)`, `array.filter(...).length`.
  //
  // 🦉 Why any order. Recall asks "did it find them", not "did it rank them the same". The reranker (section 08)
  //    reorders the candidates anyway; a true neighbour found at position 7 instead of 3 is still found.
  // 🦉 Why only found's first k. A search asked for 10 that returns 40 would otherwise get credit for neighbours
  //    it ranked 35th. And why divide by the truth's length: a search that returns 2 ids, both right, has found
  //    2 of 10, not 2 of 2. Dividing by found's length is the classic slip, and it turns a search that returns
  //    almost nothing into a perfect one.
  //
  // 🚨 The tests check recall@k on small lists, that exactNearest matches a brute-force sort of all 428 recorded
  //    vectors for every golden question even when the planner would rather use the index, and the worked example:
  //    a coarse graph (m 4) at ef_search 10 misses some true neighbours, and a wider search finds them.
  throw new Error(`recallAtK(${found.length} found, ${truth.length} true, k ${k}) isn't written yet`);
}
