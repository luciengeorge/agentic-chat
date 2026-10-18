/**
 * The lexical lab's server side (section 07): one question searched three ways for the viewer, as retrieval does it
 * before the reranker. BM25 through `#learn/search/lexical`, vectors through `#learn/search/vector`, fused by
 * `#learn/search/rrf`, so it shows the learner's code while a step of sections 06 or 07 is active. Server only.
 */
import { sql } from "drizzle-orm";

import type { Embedder } from "#learn/embed/embed";
import type { Tx } from "@/db/tenant";

import { candidateDocuments, readable, viewerPrincipals } from "#learn/retrieve/acl";
import { lexicalSearch } from "#learn/search/lexical";
import { rrf } from "#learn/search/rrf";
import { uuidArray } from "#learn/search/sql";
import { vectorSearch } from "#learn/search/vector";
import { RECORDED_MODEL, recordedQueries } from "@/core/vectors/recording";

export interface LexicalLabDeps {
  withTenant: <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** For a question the recording doesn't hold. */
  embedder: Embedder;
}

export interface RankedChunk {
  id: string;
  title: string;
  section: string | null;
  page: number | null;
  snippet: string;
  /** BM25, cosine similarity or RRF, by list. */
  score: number;
  /** Where the chunk sits in each list, from 1; null when it isn't in that list's first `perList`. */
  ranks: { bm25: number | null; vector: number | null; fused: number | null };
}

export interface Rankings {
  question: string;
  /** Where the question's vector came from, and which chunk vectors it can be compared with. */
  embedding: { source: "recording" | "embedder"; version: string };
  bm25: RankedChunk[];
  vector: RankedChunk[];
  fused: RankedChunk[];
  /** Listed chunks the ACL decision refused, left out of the lists. */
  denied: number;
}

/** Hits taken from each list, as retrieval takes them (`perList`), and how many of each to show. */
export const PER_LIST = 40;
export const SHOWN = 10;

/** The recorded questions a viewer of this tenant can pick: the golden set's, plus the bare identifiers. */
export function labQuestions(tenantSlug: string): string[] {
  return recordedQueries()
    .filter((q) => q.tenant === tenantSlug)
    .map((q) => q.question);
}

export async function rankings(
  deps: LexicalLabDeps,
  viewer: { tenantId: string; userId: string },
  question: string,
): Promise<Rankings> {
  const recorded = recordedQueries().find((q) => q.question === question);
  const embedding = recorded
    ? { vector: recorded.embedding, source: "recording" as const, version: RECORDED_MODEL }
    : {
        vector: (await deps.embedder.embed([question]))[0],
        source: "embedder" as const,
        version: deps.embedder.version,
      };

  return deps.withTenant(viewer.tenantId, async (tx) => {
    const { principalIds } = await viewerPrincipals(tx, viewer.userId);
    const documentIds = await candidateDocuments(tx, principalIds);
    const bm25 = await lexicalSearch(tx, question, { documentIds, limit: PER_LIST });
    const vector = await vectorSearch(tx, embedding.vector, {
      documentIds,
      modelVersion: embedding.version,
      limit: PER_LIST,
    });
    const fused = rrf([bm25.map((hit) => hit.id), vector.map((hit) => hit.id)]).slice(0, PER_LIST);

    const shown = [...new Set([bm25, vector, fused].flatMap((list) => list.slice(0, SHOWN).map((hit) => hit.id)))];
    const rows =
      shown.length === 0
        ? []
        : await tx.execute<{
            id: string;
            title: string;
            section: string | null;
            page: number | null;
            text: string;
            allowed: boolean;
          }>(sql`
            SELECT c.id, doc.title, c.section, c.page_start AS page, c.text,
              ${readable(viewer.userId, sql`c.document_id`)} AS allowed
            FROM chunks c JOIN documents doc ON doc.id = c.document_id AND doc.version = c.document_version
            WHERE c.id = ANY(${uuidArray(shown)})`);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const rankOf = (list: { id: string }[], id: string) => {
      const i = list.findIndex((hit) => hit.id === id);
      return i === -1 ? null : i + 1;
    };
    const denied = new Set(rows.filter((row) => !row.allowed).map((row) => row.id));
    const present = (list: { id: string; score: number }[]): RankedChunk[] =>
      list.slice(0, SHOWN).flatMap((hit) => {
        const row = byId.get(hit.id);
        if (!row?.allowed) return [];
        return [
          {
            id: hit.id,
            title: row.title,
            section: row.section,
            page: row.page,
            snippet: row.text.replace(/\s+/g, " ").slice(0, 160),
            score: hit.score,
            ranks: { bm25: rankOf(bm25, hit.id), vector: rankOf(vector, hit.id), fused: rankOf(fused, hit.id) },
          },
        ];
      });
    return {
      question,
      embedding: { source: embedding.source, version: embedding.version },
      bm25: present(bm25),
      vector: present(vector),
      fused: present(fused),
      denied: denied.size,
    };
  });
}
