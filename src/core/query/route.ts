import { sql } from "drizzle-orm";

import type { Tx } from "@/db/tenant";

import { readable } from "#learn/retrieve/acl";
import { bm25Search, buildBm25Index } from "#learn/search/bm25";
import { rrf } from "#learn/search/rrf";
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
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit must be a positive integer, got ${limit}`);
  const index = buildBm25Index(
    cards.map((card) => ({ id: card.documentId, text: `${card.title}\n${card.path}\n${card.text}` })),
  );
  const lexical = bm25Search(index, question).map((hit) => hit.id);
  const vector = cards
    .filter((card) => card.embedding !== null)
    .map((card) => ({ id: card.documentId, score: cosine(questionEmbedding, card.embedding!) }))
    .sort((a, b) => b.score - a.score)
    .map((hit) => hit.id);
  return rrf([lexical, vector])
    .slice(0, limit)
    .map((fused) => fused.id);
}
