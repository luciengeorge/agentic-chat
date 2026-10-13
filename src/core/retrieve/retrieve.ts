import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { Embedder } from "#learn/embed/embed";
import type { QueryRewriter } from "#learn/query/rewrite";
import type { Reranker } from "#learn/rerank/rerank";
import type { Tx } from "@/db/tenant";

import { lexicalSearch } from "#learn/search/lexical";
import { rrf } from "#learn/search/rrf";
import { uuidArray } from "#learn/search/sql";
import { vectorSearch } from "#learn/search/vector";

import type { Retrieval, RetrievedChunk, Retrieve, Viewer } from "./types";

import { candidateDocuments, readable, viewerPrincipals } from "./acl";

export interface RetrieveDeps {
  /** Runs `fn` in a transaction scoped to the tenant (`withTenant` in the app). */
  withTenant: <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;
  embedder: Embedder;
  reranker: Reranker;
  rewriter: QueryRewriter;
}

export interface RetrieveSettings {
  /** Chunks returned. */
  k: number;
  /** Hits taken from each BM25 and each vector list. */
  perList: number;
  /** Fused candidates the ACL decision sees: the over-fetch, so denied ones still leave enough. */
  candidates: number;
  /** Allowed candidates the reranker scores. */
  rerankDepth: number;
}

export const DEFAULT_SETTINGS: RetrieveSettings = { k: 8, perList: 40, candidates: 60, rerankDepth: 30 };

const MAX_K = 50;

type Row = Omit<RetrievedChunk, "score"> & { allowed: boolean };

export function queryHash(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

/**
 * Hybrid retrieval for one viewer:
 * 1. rewrite the question (the model, or nothing), and embed it with its rewrites;
 * 2. inside the tenant's transaction: the viewer's principals, the documents they might read (the pre-filter),
 *    BM25 and vector lists for every query over those documents, fused with RRF;
 * 3. the decision: the fused candidates joined to `document_acl` in one statement. Denied ones are dropped and
 *    recorded; so are chunks of a version that isn't the document's current one, silently;
 * 4. `acl_version_seq`'s high-water mark, read after that statement in the same transaction;
 * 5. outside it, the allowed candidates are reranked against the question (only text the viewer may read ever
 *    reaches the reranker, which may be a third party);
 * 6. the audit row, with what was returned and what was denied.
 */
export function createRetrieve(deps: RetrieveDeps, settings: Partial<RetrieveSettings> = {}): Retrieve {
  const base = { ...DEFAULT_SETTINGS, ...settings };

  return async (viewer: Viewer, query: string, options = {}): Promise<Retrieval> => {
    const k = options.k ?? base.k;
    if (!Number.isInteger(k) || k < 1 || k > MAX_K) throw new RangeError(`k must be 1 to ${MAX_K}, got ${k}`);
    const question = query.trim();
    if (question === "") throw new RangeError("the query is empty");

    const rewritten = await deps.rewriter(question);
    const queries = [question, ...rewritten];
    const embeddings = await deps.embedder.embed(queries);

    const searched = await deps.withTenant(viewer.tenantId, async (tx) => {
      const { principalIds } = await viewerPrincipals(tx, viewer.userId);
      const documentIds = await candidateDocuments(tx, principalIds);

      const lists: string[][] = [];
      for (const [i, text] of queries.entries()) {
        lists.push((await lexicalSearch(tx, text, { documentIds, limit: base.perList })).map((hit) => hit.id));
        const vectorHits = await vectorSearch(tx, embeddings[i], {
          documentIds,
          modelVersion: deps.embedder.version,
          limit: base.perList,
        });
        lists.push(vectorHits.map((hit) => hit.id));
      }
      const fused = rrf(lists).slice(0, base.candidates);

      const rows =
        fused.length === 0
          ? []
          : await tx.execute<Row>(sql`
              SELECT c.id, c.document_id AS "documentId", d.title, d.path, c.text,
                c.page_start AS "pageStart", c.page_end AS "pageEnd", c.section,
                ${readable(viewer.userId, sql`c.document_id`)} AS allowed
              FROM chunks c
              JOIN documents d ON d.id = c.document_id AND d.version = c.document_version
              WHERE c.id = ANY(${uuidArray(fused.map((entry) => entry.id))})`);

      const [{ mark }] = await tx.execute<{ mark: string }>(
        sql`SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS mark FROM acl_version_seq`,
      );

      const byId = new Map(rows.map((row) => [row.id, row]));
      const allowed: Row[] = [];
      const denied: string[] = [];
      for (const { id } of fused) {
        const row = byId.get(id);
        if (!row) continue;
        if (row.allowed) allowed.push(row);
        else denied.push(id);
      }
      return { allowed, denied, aclVersion: Number(mark) };
    });

    const pool = searched.allowed.slice(0, base.rerankDepth);
    const ranked = await deps.reranker.rerank(
      question,
      pool.map((row) => row.text),
      k,
    );
    const chunks: RetrievedChunk[] = ranked.map(({ index, score }) => {
      const { allowed: _allowed, ...chunk } = pool[index];
      return { ...chunk, score };
    });

    const auditId = await deps.withTenant(viewer.tenantId, async (tx) => {
      const [row] = await tx.execute<{ id: string }>(sql`
        INSERT INTO retrieval_audit (tenant_id, user_id, query_hash, returned_ids, denied_ids, acl_version)
        VALUES (${viewer.tenantId}, ${viewer.userId}, ${queryHash(question)},
          ${uuidArray(chunks.map((chunk) => chunk.id))}, ${uuidArray(searched.denied)}, ${searched.aclVersion})
        RETURNING id`);
      return row.id;
    });

    return { query: question, rewritten, chunks, auditId };
  };
}
