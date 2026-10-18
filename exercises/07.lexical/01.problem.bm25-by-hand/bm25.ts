// 👨‍💼 Leo asks about contract KPC-2026-0142 and the vector search hands him the contract register, because to an
//    embedding every contract number looks alike. Search by the exact words has to rank too: a chunk that holds
//    "0142" three times, in a corpus where only 9 chunks hold it at all, should come first. BM25 is how.

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

/** Inverse document frequency: how much finding a term in a document says, given how many documents hold it. */
export function idf(documents: number, withTerm: number): number {
  // 🐨 Return Lucene's idf: the natural log of 1 + (N - df + 0.5) / (df + 0.5), where N is `documents`, the
  //    corpus size, and df is `withTerm`, how many documents hold the term.
  //
  // 💰 `Math.log` is the natural log.
  //
  // 🦉 Why rare terms count more. A term in 9 of 434 chunks ("0142") narrows the search to those 9; a term in 363
  //    of them ("the") narrows nothing. (N - df) / df is the odds against a document holding the term, and the log
  //    keeps a term that's 100 times rarer from counting 100 times more.
  // 🦉 Why the 0.5s and the 1, the classic mistake. Robertson's original idf is ln((N - df + 0.5) / (df + 0.5)),
  //    and for a term in more than half the documents it goes negative: holding the word would lower a score.
  //    Lucene (and Tantivy, so pg_search) adds 1 inside the log, which keeps idf above zero for every term, even
  //    one in every document. The 0.5s smooth the ends: no division by zero for a term nobody has, and a term
  //    everyone has still counts a little. Drop them and a term in every document counts exactly nothing.
  //
  // 📜 https://en.wikipedia.org/wiki/Okapi_BM25
  throw new Error(`idf(${documents} documents, ${withTerm} with the term) isn't written yet`);
}

/**
 * One term's contribution to one document's score: tf saturated by k1, divided down for a document longer than
 * average by b.
 */
export function termScore(
  tf: number,
  termIdf: number,
  length: number,
  averageLength: number,
  { k1, b }: Bm25Params = { k1: DEFAULT_K1, b: DEFAULT_B },
): number {
  // 🐨 A term that isn't there (tf 0) adds 0.
  // 🐨 Otherwise build it from three pieces, and arrange them yourself:
  //    - a length norm: this document's length over the average, weighted by b. With b 0 it's always 1, with b 1
  //      it's the plain ratio, and in between it's that share of the ratio plus the rest of 1;
  //    - tf saturated by k1: a fraction of tf that starts near 0, climbs fast and flattens toward 1, with k1 setting
  //      how soon. Length goes in here: the length norm scales k1, so a long document needs more mentions to reach
  //      the same fraction;
  //    - a scale: idf, times the constant that makes one mention in a document of average length worth exactly idf.
  //    Check yourself against the README: chunk 7's length norm is 2.07, and its 12 mentions of kpc give 4.9689.
  //
  // 🦉 Why tf saturates. A chunk that says "hotel" 6 times isn't 6 times more about hotels than one that says it
  //    once. The fraction climbs fast, then flattens: with k1 = 1.2, one mention in an average-length chunk gives
  //    0.45 of the most a term can give, two 0.62, ten 0.89. The constant on top only rescales. Leave it out and
  //    every score shrinks by the same factor, which ranks the same but no longer matches pg_search.
  // 🦉 Why length counts. A long chunk mentions more words just by being long. lengthNorm is 1 for a chunk of
  //    average length, above 1 for a longer one (which raises the denominator and lowers the score), below 1 for a
  //    shorter one. b says how much: 0 ignores length, 1 divides fully by it. Lucene's defaults are k1 1.2 and
  //    b 0.75.
  //
  // 🚨 The tests check idf and termScore on a three-document corpus worked by hand, that idf stays above zero for
  //    a term in every document, that a second mention adds less than the first and a long document gets less for
  //    the same count, and that your formula gives pg_search's own scores over the 434 recorded chunks.
  throw new Error(
    `termScore(tf ${tf}, idf ${termIdf}, length ${length} of ${averageLength}, k1 ${k1}, b ${b}) isn't written yet`,
  );
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
