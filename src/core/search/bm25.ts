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
 * once, as pg_search's `|||` does.
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
