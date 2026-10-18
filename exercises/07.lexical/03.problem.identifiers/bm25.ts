// 👨‍💼 Leo asks about KPC-2026-0142 and lexical search gets it right where vector search doesn't. When someone at
//    Kestrel asks why a chunk came first (or why it didn't), the answer is in the score, and the score is a sum of
//    one part per word. This step makes that sum readable.

/**
 * BM25 by hand: the formula pg_search (and Lucene, and Tantivy underneath it) ranks with. One small function per
 * piece, so each can be read, tested and swapped on its own.
 *
 * score(doc, query) = sum over the query's terms t of  idf(t) * tf * (k1 + 1) / (tf + k1 * (1 - b + b * len / avgLen))
 *
 * - tf: how often t appears in the document. More is better, but each extra mention adds less (k1 sets how fast it
 *   saturates).
 * - idf: how rare t is across all documents. A word in every document tells you nothing; a contract number in one
 *   tells you a lot.
 * - len / avgLen: a long document mentions everything a bit, so its tf counts for less (b sets how much).
 */

/** Lucene's and Tantivy's defaults, which pg_search uses. */
export const DEFAULT_K1 = 1.2;
export const DEFAULT_B = 0.75;

export interface Bm25Params {
  k1: number;
  b: number;
}

/** Lowercased runs of letters and digits: "KPC-2026-0142" becomes kpc, 2026, 0142. No stemming, no stopwords. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Inverse document frequency, in the form Lucene uses: ln(1 + (N - df + 0.5) / (df + 0.5)). `documents` is N, the
 * corpus size; `withTerm` is df, how many documents hold the term. The `1 +` keeps it above zero even for a term in
 * every document.
 */
export function idf(documents: number, withTerm: number): number {
  return Math.log(1 + (documents - withTerm + 0.5) / (withTerm + 0.5));
}

/**
 * One term's contribution to one document's score. With b = 0 length doesn't matter; with b = 1 tf is fully divided
 * by the document's length relative to the average.
 */
export function termScore(
  tf: number,
  termIdf: number,
  length: number,
  averageLength: number,
  { k1, b }: Bm25Params = { k1: DEFAULT_K1, b: DEFAULT_B },
): number {
  if (tf === 0) return 0;
  const lengthNorm = 1 - b + b * (length / averageLength);
  return (termIdf * (tf * (k1 + 1))) / (tf + k1 * lengthNorm);
}

/** What BM25 needs to know about a corpus, computed once. */
export interface Bm25Index {
  ids: string[];
  /** Per document, how often each of its terms appears. */
  termCounts: Map<string, number>[];
  lengths: number[];
  averageLength: number;
  /** How many documents hold each term. */
  documentFrequency: Map<string, number>;
}

export function buildBm25Index(documents: { id: string; text: string }[]): Bm25Index {
  const termCounts: Map<string, number>[] = [];
  const lengths: number[] = [];
  const documentFrequency = new Map<string, number>();
  for (const { text } of documents) {
    const counts = new Map<string, number>();
    const tokens = tokenize(text);
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const term of counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    termCounts.push(counts);
    lengths.push(tokens.length);
  }
  const total = lengths.reduce((sum, length) => sum + length, 0);
  return {
    ids: documents.map((document) => document.id),
    termCounts,
    lengths,
    averageLength: documents.length === 0 ? 0 : total / documents.length,
    documentFrequency,
  };
}

/**
 * Every document holding at least one query term, best first (ties by id). A term repeated in the query counts
 * once. pg_search's `|||` differs in two ways (checked on 0.26.1 over the 434 recorded chunks, where with both
 * applied the scores agree to 32-bit precision): it scores a repeated query term each time it appears, and it
 * keeps each document's length in one byte (Tantivy's field norm), exact up to 40 tokens and rounded down to a
 * coarser step above (234 becomes 232).
 */
export function bm25Search(
  index: Bm25Index,
  query: string,
  params: Bm25Params = { k1: DEFAULT_K1, b: DEFAULT_B },
): { id: string; score: number }[] {
  const terms = [...new Set(tokenize(query))];
  const n = index.ids.length;
  const out: { id: string; score: number }[] = [];
  index.termCounts.forEach((counts, i) => {
    let score = 0;
    let matched = false;
    for (const term of terms) {
      const tf = counts.get(term) ?? 0;
      if (tf === 0) continue;
      matched = true;
      const termIdf = idf(n, index.documentFrequency.get(term) ?? 0);
      score += termScore(tf, termIdf, index.lengths[i], index.averageLength, params);
    }
    if (matched) out.push({ id: index.ids[i], score });
  });
  return out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface TermExplanation {
  term: string;
  /** How often the term appears in this document. */
  tf: number;
  /** How many documents in the index hold it. */
  documentFrequency: number;
  idf: number;
  /** What the term adds to the document's score: 0 when it's absent. */
  score: number;
}

/** Why one document scored what it did, term by term. Null for an id the index doesn't hold. */
export function explainScore(
  index: Bm25Index,
  query: string,
  id: string,
  params: Bm25Params = { k1: DEFAULT_K1, b: DEFAULT_B },
): { score: number; terms: TermExplanation[] } | null {
  // 🐨 Find the document's position in the index (null if it isn't there).
  // 🐨 For each distinct term of the query, in the order the query has them: its tf in this document (0 if
  //    absent), its df across the index, its idf, and what it adds (your termScore, with this document's length
  //    and the index's average). Keep the absent terms too: tf 0 and score 0 say "the word wasn't there".
  // 🐨 Return those terms and their sum as `score`. It must equal what bm25Search gives the same document.
  //
  // 💰 `index.ids.indexOf(id)`, `index.termCounts[i].get(term) ?? 0`, `index.documentFrequency.get(term) ?? 0`,
  //    `[...new Set(tokenize(query))]`.
  //
  // 🦉 Why a breakdown is worth writing. A search engine's score is a sum, and a sum hides where it came from.
  //    Split it and you see which words decided the ranking. For "Who owns contract KPC-2026-0142, and when does
  //    its initial term end?" the MSA's first page wins at 22.17, and its biggest part isn't the contract number:
  //    it's "initial" (6.06), which only 3 of the 434 chunks contain. "0142" (in 9) adds 3.36, "and" (in 351)
  //    adds 0.27. Rare words decide; that's idf at work.
  // 🦉 Why BM25 beats vectors here. A term is either in a chunk or not. "0142" is a string of digits to BM25,
  //    found or missed exactly. To an embedding it's a few tokens that mean "some contract number", much like
  //    "0298" or "0412", so a page about contracts in general sits closer than the one contract that matters.
  //    Error codes (KP-4031), product codes (KC-PRO-12) and invoice numbers behave the same way.
  // 🦉 Why distinct terms. bm25Search counts a repeated query word once; the breakdown must add up to its score,
  //    so it can't count it twice either.
  // 🦉 New in this file, already written: the `TermExplanation` type, the shape of one part.
  //
  // 🚨 The tests check that the parts add up to bm25Search's score for real questions and chunks, that every
  //    distinct query term is listed in query order (absent ones with tf 0), that df and idf are the index's, and
  //    the worked example: KPC-2026-0142 by BM25 and by vectors.
  throw new Error(
    `explainScore("${query}", ${id}, of ${index.ids.length} documents, k1 ${params.k1}) isn't written yet`,
  );
}
