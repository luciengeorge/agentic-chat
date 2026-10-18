// 👨‍💼 Ask about the expenses policy, and 5,274 chunks of the FCA filing compete with its few pages, because the
//    filing says "expenses" too. Routing picks the few documents a question is about first, and searches only
//    those. Kestrel wants to know whether that's better than searching everything.

import { sql } from "drizzle-orm";

import type { Tx } from "@/db/tenant";

import { readable } from "#learn/retrieve/acl";
import { uuidArray } from "#learn/search/sql";

/**
 * Document-level routing: pick the few documents a question is about first, then search chunks only inside them.
 * A question about the expenses policy shouldn't compete with 5,000 chunks of the annual filing that mention
 * "expenses" once each.
 *
 * Each document gets a card: its title, its path and its first chunk (which usually opens with the title and says
 * what the document is). Cards are ranked two ways, by BM25 over their text (the hand-built `#learn/search/bm25`)
 * and by the cosine similarity of the first chunk's vector to the question's, and the two lists are fused with RRF.
 *
 * Cards are made only for documents the viewer can read (the same `readable` rule as the final decision), so
 * routing can't pick, or reveal, one they can't. The final decision still runs on every chunk afterwards.
 */
export interface DocumentCard {
  documentId: string;
  title: string;
  path: string;
  /** The first chunk's text, at the document's current version. */
  text: string;
  /** The first chunk's vector, when it was embedded by the query's model; else null. */
  embedding: number[] | null;
}

/** One card per document in `documentIds` that the user may read. Run it inside `withTenant`. The aliases aren't
 * `d` or `a`: `readable`'s subqueries use those, and would capture them. */
export async function documentCards(
  tx: Tx,
  userId: string,
  documentIds: readonly string[],
  modelVersion: string,
): Promise<DocumentCard[]> {
  if (documentIds.length === 0) return [];
  const rows = await tx.execute<{
    documentId: string;
    title: string;
    path: string;
    text: string;
    embedding: string | null;
  }>(sql`
    SELECT DISTINCT ON (doc.id) doc.id AS "documentId", doc.title, doc.path, first.text,
      CASE WHEN first.embedding_model_version = ${modelVersion} THEN first.embedding::text END AS embedding
    FROM documents doc
    JOIN chunks first ON first.document_id = doc.id AND first.document_version = doc.version
    WHERE doc.id = ANY(${uuidArray(documentIds)}) AND ${readable(userId, sql`doc.id`)}
    ORDER BY doc.id, first.ordinal`);
  return rows.map((row) => ({ ...row, embedding: row.embedding === null ? null : JSON.parse(row.embedding) }));
}

/** How close two vectors point: 1 the same way, 0 at right angles. */
export const cosine = (a: readonly number[], b: readonly number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
};

/** The `limit` documents most about the question, best first. */
export function routeDocuments(
  question: string,
  questionEmbedding: readonly number[],
  cards: DocumentCard[],
  limit: number,
): string[] {
  // 🐨 Refuse a `limit` that isn't a whole number of at least 1 with a RangeError.
  // 🐨 Rank the cards by words: a BM25 index over each card's title, path and text together, searched with the
  //    question. Keep the document ids, best first.
  // 🐨 Rank the cards by meaning: the cosine similarity of each card's vector to the question's, highest first.
  //    A card whose vector is null (embedded by another model) has no place in this list. It isn't dropped: it
  //    can still come in through the words.
  // 🐨 Fuse the two lists with RRF and return the first `limit` ids.
  //
  // 💰 Add `import { bm25Search, buildBm25Index } from "#learn/search/bm25"` and `import { rrf } from
  //    "#learn/search/rrf"`. `buildBm25Index([{ id, text }])`, then `bm25Search(index, question)` gives
  //    `{ id, score }[]` best first. `rrf([listA, listB])` gives `{ id, score }[]` best first. `cosine(a, b)` is
  //    above. `Number.isInteger(limit)`.
  //
  // 🦉 What a card is, and why title and path count. `documentCards` (written, above) makes one per document the
  //    viewer may read: its title, its path and its first chunk, which usually says what the document is. A
  //    title like "Contract Register 2026-09-28.pdf" is the best summary a document has.
  // 🦉 Why both rankings, fused. BM25 catches the exact word ("register", "KPC-2026-0142"); the vector catches
  //    the topic in other words. Each misses what the other catches, and RRF adds their votes by rank, so
  //    neither scale has to match the other (section 07).
  // 🦉 Why it loses here. A card knows a document by its front page. The FCA filing's first chunk is its cover:
  //    title, firm, reporting period. Merchant M-221449's exit is on page 2,861 of 3,000. No card can say that,
  //    so a question about it is routed to five other documents and searches none of the 5,274 chunks that could
  //    answer. That's `pnpm eval --route 5`'s miss: recall@10 0.950 against 1.000.
  // 🦉 New in this file, already written: `documentCards`, with its own aliases. `readable()` (section 09)
  //    names its subqueries' tables `acl_d` and `acl_a` for the same reason: an alias the caller also uses
  //    would be captured by the subquery.
  //
  // 📜 https://www.pinecone.io/learn/series/rag/rerankers/ (the two-stage idea: cheap and wide, then narrow)
  //
  // 🚨 The tests check that the two rankings are summed with RRF (not one trusted alone), that the highest
  //    cosine comes first, that the title and path count, that a card without a vector still routes, the limit,
  //    and that Sofia's merchant question is routed to five documents without the filing.
  throw new Error(
    `routeDocuments(${JSON.stringify(question)}, ${questionEmbedding.length} dimensions, ${cards.length} cards, limit ${limit}) isn't written yet`,
  );
}
