// 👨‍💼 Every question the assistant answers runs a BM25 search and a vector search, for the question and each of its
//    rewrites: four to eight ranked lists. The reranker can only look at about 30 chunks, so those lists have to
//    become one ranking first. Their scores can't be compared (a BM25 of 22 and a cosine of 0.6 aren't on any
//    common scale), so the merge has to use something else.

/** RRF's constant: ranks deep in a list still count, but the top few dominate. */
export const RRF_K = 60;

export interface Fused {
  id: string;
  score: number;
}

/** Reciprocal rank fusion: many ranked lists of ids into one ranking, best first. */
export function rrf(lists: string[][], k = RRF_K): Fused[] {
  // 🐨 Give every id a running total. For each list, for each id at rank r (counted from 1, so the first is rank
  //    1), add 1 / (k + r) to that id's total. An id repeated within one list counts once, at its best (first)
  //    rank. An id in only some of the lists still gets what those lists give it.
  // 🐨 Return every id with its total, highest first. Ids with equal totals keep the order they were first seen in.
  //
  // 💰 A `Map<string, number>` keeps insertion order; `new Set<string>()` per list remembers what it has seen.
  //    `list.forEach((id, index) => ...)` gives a 0-based index. `[...map].map(([id, score]) => ({ id, score }))`.
  //    Array `sort` keeps equal elements in their order.
  //
  // 🦉 Why ranks, not scores, the classic mistake. A BM25 score runs from 0 to 20 and more; a cosine similarity from
  //    0 to 1. Add them and BM25 decides everything: for Leo's KPC-2026-0142 question the sum is simply BM25's
  //    order, as if the vector search hadn't run. Scale them to 0..1 and a list with one strong hit and a tail of
  //    weak ones looks like a list of equals. Ranks have the same meaning in every list: first is first.
  // 🦉 Why 1 / (60 + rank). The first place gives 1/61 and the tenth 1/70: deep places still count, but not much
  //    less than the top, so a chunk ranked well by both lists beats one ranked first by only one. The 60 comes
  //    from the paper that introduced RRF (Cormack, Clarke and Büttcher, 2009), where it worked best; a small k
  //    would let one list's first place win alone.
  // 🦉 Why the union. A chunk only BM25 found (an identifier the vectors missed) must still be in the result.
  //    Keeping only chunks both lists found would throw away exactly what hybrid search is for.
  //
  // 📜 https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf
  //
  // 🚨 The tests check the hand-worked sums, ranks counted from 1, that an id in one list only is kept, that an id
  //    twice in one list counts once, that ties keep first-seen order, and Leo's question fused from the BM25 and
  //    vector lists of the recorded chunks.
  throw new Error(`rrf(${lists.length} lists, k ${k}) isn't written yet`);
}
