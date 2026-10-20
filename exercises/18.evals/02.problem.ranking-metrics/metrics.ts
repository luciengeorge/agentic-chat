// 👨‍💼 Three numbers per question, averaged per run, so the team can tell a better retrieval from a worse one: did
//    it find the labelled pages (recall@k), how soon (MRR), and how high they all ranked (NDCG). `pnpm eval` writes
//    them into every report, and its gates fail a run whose recall@10 drops under 0.85 or MRR under 0.6.
//
// 🦉 New in this file: `mean`, written (the run's averages use it). `hitsLabel` and `judge` are step 1's answer.
//    You write `recallAtK`, `reciprocalRank` and `ndcgAtK`, which read the column `judge` returns.

/**
 * Ranking metrics over golden labels. A label is a document page (or a whole document, for md and docx, which have
 * no pages), never a chunk id: chunk ids change whenever chunking does, and a page is what a person can check.
 */

export interface Label {
  path: string;
  /** null for md and docx: any chunk of the document hits it. */
  page: number | null;
}

/** What the metrics need from a retrieved chunk. */
export interface RankedChunk {
  path: string;
  pageStart: number | null;
  pageEnd: number | null;
}

/** The chunk is from the labelled document and, for a paged label, its pages include the label's page. */
export function hitsLabel(label: Label, chunk: RankedChunk): boolean {
  if (label.path !== chunk.path) return false;
  if (label.page === null) return true;
  if (chunk.pageStart === null) return false;
  return chunk.pageStart <= label.page && label.page <= (chunk.pageEnd ?? chunk.pageStart);
}

/**
 * For each chunk in rank order, the index of the label it finds, or null. A chunk finds the first label it hits
 * that no higher chunk found already, so three chunks of one page count once: a ranking can't score by repeating
 * itself.
 */
export function judge(chunks: RankedChunk[], labels: Label[]): (number | null)[] {
  const found = new Set<number>();
  return chunks.map((chunk) => {
    const index = labels.findIndex((label, i) => !found.has(i) && hitsLabel(label, chunk));
    if (index === -1) return null;
    found.add(index);
    return index;
  });
}

/** recall@k: the share of the labels found in the top k. */
export function recallAtK(judged: (number | null)[], labelCount: number, k: number): number {
  // 🐨 Count the chunks in the top k that found a label, and divide by how many labels the question has.
  // 🐨 A question with no labels has no recall: throw a `RangeError` (`need at least one label, got 0`) for a
  //    `labelCount` that isn't a whole number of at least 1. `recallAtK` and `ndcgAtK` both need it.
  // 🐨 The classic mistake: dividing by k. That's precision@k, the share of the top k that are labels. Daniel has
  //    3 labels, all in his top 10: his recall@10 is 3/3, not 3/10.
  //
  // 💰 `judged.slice(0, k)`. `Number.isInteger`.
  //
  // 🦉 Why recall is the first gate. A page that isn't retrieved can't be read by the model, so no prompt, however
  //    good, can answer from it. Recall@k says whether the pages were there at all. It says nothing about order:
  //    labels at ranks 9 and 10 score the same as ranks 1 and 2.
  //
  // 🚨 The tests check a share, a smaller k, nothing found, the RangeError, and Daniel's 0.333, 0.667 and 1.
  throw new Error(`recallAtK(${judged.length} judged, ${labelCount} labels, k ${k}) isn't written yet`);
}

/** 1 divided by the rank of the first chunk that finds a label; 0 when none does. Averaged, it's MRR. */
export function reciprocalRank(judged: (number | null)[]): number {
  // 🐨 Find the first chunk that found a label. Its rank is its index plus 1; the answer is 1 over that rank. No
  //    chunk found one: 0.
  // 🐨 The classic mistake: 1 over the index. The top chunk is index 0 and rank 1: it must score 1, not Infinity.
  //
  // 🦉 Why only the first. A chat answer reads the top few chunks; the first relevant one is most of what decides
  //    it. Rachel Obi's London hotel question finds its label at rank 2, under version 1 of the policy: 0.5, and
  //    that's what pulls the run's MRR below 1. It also means MRR can't see Daniel's other two labels at all.
  //
  // 🚨 The tests check rank 1, rank 3, nothing found and an empty ranking.
  throw new Error(`reciprocalRank(${judged.length} judged) isn't written yet`);
}

/**
 * NDCG@k with binary gains: each found label is worth 1, discounted by log2(rank + 1). It's divided by the best
 * possible score, every label in the first places, so a perfect ranking scores 1.
 */
export function ndcgAtK(judged: (number | null)[], labelCount: number, k: number): number {
  // 🐨 DCG: for each chunk in the top k that found a label, add `1 / log2(rank + 1)`, where rank counts from 1.
  // 🐨 Ideal DCG: the same sum with a label at each of ranks 1, 2, 3... for as many labels as there are, but never
  //    more places than k. Return DCG over ideal. Refuse a `labelCount` under 1, as `recallAtK` does.
  // 🐨 The classic mistakes: `log2(rank)` (rank 1 gives log2(1) = 0, a division by zero), and an ideal that counts
  //    every label when k is smaller (3 labels at k = 1: the best possible is one label at rank 1, so a hit there
  //    scores 1).
  //
  // 💰 `Math.log2`, `Math.min`.
  //
  // 🦉 Why log2(rank + 1). The discount should fall fast at the top and slowly after, as people's attention does:
  //    rank 1 is worth 1, rank 2 0.63, rank 3 0.5, rank 10 0.29. The + 1 is what makes rank 1 worth exactly 1
  //    (log2(2) = 1). A label at rank 10 still counts something, which reciprocal rank never gives it.
  // 🦉 Why divide by the ideal. A question with three labels can score up to 2.13, one with a single label up to
  //    1. Divided by its own best, every question scores from 0 to 1, so a run's average means the same thing
  //    whatever mix of questions it has.
  //
  // 🚨 The tests check a perfect ranking, one label at rank 3 (0.5), two labels, the ideal capped at k, hits below
  //    k ignored, and Daniel's 0.645.
  throw new Error(`ndcgAtK(${judged.length} judged, ${labelCount} labels, k ${k}) isn't written yet`);
}

export function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
