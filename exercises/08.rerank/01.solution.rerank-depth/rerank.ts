import { type RerankingModel, rerank as aiRerank } from "ai";

import { words } from "#learn/embed/fake";

export interface Ranked {
  /** Index into the documents passed in. */
  index: number;
  score: number;
}

/** Scores each document against the query and returns the best `topN`, best first. */
export interface Reranker {
  name: string;
  rerank(query: string, documents: string[], topN: number): Promise<Ranked[]>;
}

/**
 * Reranks the first `depth` candidates against the query and returns the best `k`, best first, each with the
 * reranker's score. The depth is how far down the fused list the reranker reads: a chunk below it can never come
 * back, however relevant. `retrieve` passes the allowed candidates in fused order.
 */
export async function rerankCandidates<T extends { text: string }>(
  reranker: Reranker,
  query: string,
  candidates: readonly T[],
  options: { depth: number; k: number },
): Promise<(T & { score: number })[]> {
  const pool = candidates.slice(0, options.depth);
  const ranked = await reranker.rerank(
    query,
    pool.map((candidate) => candidate.text),
    options.k,
  );
  return ranked.map(({ index, score }) => ({ ...pool[index], score }));
}

/**
 * A hosted cross-encoder (Cohere) through the AI SDK's `rerank()`. The SDK retries a 429 or a 5xx with exponential
 * backoff from 2 s, honouring the provider's retry-after; `maxRetries` 5 waits out about a minute, a trial key's
 * rate-limit window.
 */
export function aiSdkReranker(model: RerankingModel, name: string, options: { maxRetries?: number } = {}): Reranker {
  const { maxRetries = 5 } = options;
  return {
    name,
    async rerank(query, documents, topN) {
      if (documents.length === 0) return [];
      const { ranking } = await aiRerank({
        model,
        query,
        documents,
        topN: Math.min(topN, documents.length),
        maxRetries,
      });
      return ranking.map((entry) => ({ index: entry.originalIndex, score: entry.score }));
    },
  };
}

const STOPWORDS = new Set(
  "a an and are as at be by did do does for from has have how i in is it its me my of on or our that the their this to was we what when where which who why will with you your".split(
    " ",
  ),
);

/**
 * A deterministic stand-in until there's a Cohere key: the share of the query's distinct words (stopwords aside)
 * that the document contains, from 0 to 1. Ties keep the order the documents came in, which is the fused order.
 */
export function overlapReranker(): Reranker {
  return {
    name: "fake-overlap-v1",
    async rerank(query, documents, topN) {
      const terms = [...new Set(words(query).filter((word) => !STOPWORDS.has(word)))];
      return documents
        .map((document, index) => {
          if (terms.length === 0) return { index, score: 0 };
          const present = new Set(words(document));
          return { index, score: terms.filter((term) => present.has(term)).length / terms.length };
        })
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, topN);
    },
  };
}
