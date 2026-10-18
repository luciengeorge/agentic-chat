// 👨‍💼 Search hands back 60 candidates for Sofia Lindqvist's question about complaint CMP-2026-01171, and the
//    first 26 are pages of the FCA filing's complaints register: the same words, in table after table. The page
//    that answers her sits at #27. A reranker reads the question and each candidate together, and puts the page
//    that answers first. But it only reads as far down the list as you let it.

import { type RerankingModel } from "ai";

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
  // 🐨 Take the first `options.depth` candidates: that's the pool the reranker reads. Not the first `k`: the
  //    classic mistake. Rerank only as many as you'll return, and the reranker can reorder them but never bring
  //    one up from below, so the depth does nothing.
  // 🐨 Send the reranker the query and the pool's text, and ask for the best `options.k`.
  // 🐨 Each entry it returns has an `index` into the pool you sent and a `score`. Return the pool candidate at
  //    that index, whole, with the score added, in the reranker's order.
  //
  // 💰 `list.slice(0, n)` is the first n (all of them if there are fewer). `{ ...candidate, score }` copies a
  //    candidate and adds a field.
  //
  // 🦉 Why a reranker at all. BM25 and the vectors score the question and a chunk apart: each chunk was turned
  //    into a vector, or counted into an index, before anyone asked anything. A reranker (a cross-encoder) reads
  //    the question and one chunk together, word against word, and scores how well that chunk answers. It's the
  //    librarian who opens each book instead of reading the spines. That's far better, and far too slow for the
  //    whole corpus, so it runs only on the candidates search already found.
  // 🦉 Why the depth matters. Fusion ranks by agreement between lists. Sofia's question names a complaint
  //    reference, and the FCA filing's complaints register is page after page of complaint references, so its
  //    pages fill the top of every list. The report page that answers her is near the top of the four BM25 lists
  //    and in none of the vector lists, so it fuses to #27. At depth 30 the reranker reads it and puts it #2. At
  //    depth 8 it's never read, and never returned.
  // 🦉 What depth costs. Cohere bills by search unit (a query and up to 100 documents), and each document adds
  //    time: 30 is a balance. A third party also sees every chunk you send, which is why retrieval reranks only
  //    the candidates the viewer may read (section 09).
  //
  // 📜 https://docs.cohere.com/docs/reranking-best-practices
  //
  // 🚨 The tests check that the report's page 3, the 27th candidate, comes back at depth 30 and not at depth 8;
  //    that the reranker is sent at most `depth` candidates' text, in order; that each result is the candidate at
  //    the ranking's index, whole, with its score; and that Cohere's recorded answer takes fused #28 and #27 to
  //    the top.
  throw new Error(
    `rerankCandidates(${reranker.name}, ${JSON.stringify(query)}, ${candidates.length} candidates, depth ${options.depth}, k ${options.k}) isn't written yet`,
  );
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
      // 🐨 No documents: return [] without calling the model.
      // 🐨 Otherwise call the AI SDK's `rerank()` with the model, the query, the documents, `maxRetries`, and a
      //    `topN` that's no more than the number of documents.
      // 🐨 Map its `ranking` to `{ index, score }`: the index is the entry's `originalIndex`, where that document
      //    sat in the list you sent. Its place in the ranking is the order you return them in.
      //
      // 💰 Add `rerank as aiRerank` to the import from "ai" (named so it doesn't clash with this method).
      //    `const { ranking } = await aiRerank({ model, query, documents, topN, maxRetries })`; each entry has
      //    `originalIndex`, `score` and `document`. `Math.min(a, b)` is the smaller.
      //
      // 🦉 Why `originalIndex`. Cohere sends back the best documents first, each with the index it had in your
      //    request. Retrieval looks the chunk up by that index. Take the ranking's position instead, and every
      //    chunk gets the score of a different one: the first result is always the first candidate, so the
      //    reranker seems to do nothing.
      // 🦉 Why `maxRetries`. A trial key allows 10 calls a minute. The SDK retries a 429 with backoff from 2 s and
      //    honours Cohere's retry-after; 5 retries wait out about a minute. After that the retrieval fails: it
      //    never falls back to the fused order without saying so.
      //
      // 📜 https://ai-sdk.dev/docs/reference/ai-sdk-core/rerank
      //
      // 🚨 The tests check that Cohere's recorded ranking maps back to indexes 27, 26, 5, 18, 0, 9, 12 and 6;
      //    that topN is capped at the documents sent and nothing is called for none; and that 1 retry means 2
      //    calls.
      throw new Error(
        `${name}.rerank(${JSON.stringify(query)}, ${documents.length} documents, topN ${topN}, model ${typeof model}, maxRetries ${maxRetries}) isn't written yet`,
      );
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
