/** RRF's constant: ranks deep in a list still count, but the top few dominate. */
export const RRF_K = 60;

export interface Fused {
  id: string;
  score: number;
}

/**
 * Reciprocal rank fusion: an id scores the sum of 1 / (k + rank) over the lists it appears in, rank counted from 1.
 * Only ranks matter, so BM25 scores and cosine distances never have to be put on one scale. An id listed twice in
 * one list counts once, at its best rank. Ties keep the order in which ids were first seen.
 */
export function rrf(lists: string[][], k = RRF_K): Fused[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((id, index) => {
      if (seen.has(id)) return;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
