// 👨‍💼 Leo Martin searches for "Project Heron acquisition of Lumen Ledger board vote". He may not read a word of
//    the Heron documents, and he should still get eight useful chunks, from the documents he may read. Searching
//    everything and deciding afterwards gives him nothing. Deciding only inside the search is too slow to do
//    exactly. So: a cheap, wide filter inside the search, and the exact decision after it.

import { type SQL, sql } from "drizzle-orm";

import type { Tx } from "@/db/tenant";

import { cachedPrincipals, type PrincipalCache, sharedPrincipalCache } from "#learn/acl/principal-cache";

/** The viewer is not a principal of this tenant: the directory hasn't synced them, or they belong elsewhere. */
export class UnknownViewerError extends Error {
  override name = "UnknownViewerError";
}

export interface ViewerPrincipals {
  userId: string;
  /** The user and every group in their closure, enabled or not: the pre-filter's key, never the decision. */
  principalIds: string[];
}

/**
 * The user plus every group they're in, directly or through nesting (`group_closure`). Read through the principal
 * cache, which reuses a set until directory sync bumps the tenant's version; pass `null` to read it every time.
 */
export async function viewerPrincipals(
  tx: Tx,
  userId: string,
  cache: PrincipalCache | null = sharedPrincipalCache,
): Promise<ViewerPrincipals> {
  const principalIds = cache
    ? await cachedPrincipals(tx, userId, cache, loadPrincipals)
    : await loadPrincipals(tx, userId);
  return { userId, principalIds };
}

async function loadPrincipals(tx: Tx, userId: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string; kind: string }>(sql`
    SELECT id, kind FROM principals WHERE id = ${userId}
    UNION ALL
    SELECT group_id, 'group' FROM group_closure WHERE member_id = ${userId}`);
  if (!rows.some((row) => row.id === userId && row.kind === "user")) {
    throw new UnknownViewerError(`no user principal ${userId} in this tenant`);
  }
  return rows.map((row) => row.id);
}

/**
 * The recall pre-filter: ready documents with an `allow` row for any of the principals. It's cheap and errs wide
 * (it ignores disabled principals and `deny` rows), so the search can run inside the index on a list of ids. It
 * decides nothing: `readable` does.
 */
export async function candidateDocuments(tx: Tx, principalIds: readonly string[]): Promise<string[]> {
  // 🐨 No principals: no documents (and no query).
  // 🐨 Otherwise, the distinct ids of the documents that are 'ready' and have an `allow` row naming any of the
  //    principal ids you're given. Use the ids as they are: they may come from the cache (step 2).
  //
  // 💰 Add `import { uuidArray } from "#learn/search/sql"`. `a.principal_id = ANY(${uuidArray(ids)})` matches any
  //    id in a list. `SELECT DISTINCT d.id FROM documents d JOIN document_acl a ON ...`.
  //
  // 🦉 Why a pre-filter at all. BM25 and the vector search each return their best 40, then fusion keeps 60. If
  //    they search everything, Leo's best 40 for "Project Heron" are Heron chunks, and the decision throws them
  //    away after the limit: the classic mistake of filtering ACLs after the LIMIT. On this corpus, the first 8
  //    fused chunks are all from /Exec, so a search that decides after taking 8 gives Leo nothing at all. The
  //    list of documents goes into both searches instead (`document_id = ANY(...)`, inside the index), so every
  //    one of their 40 is a chunk Leo might read.
  // 🦉 Why it's allowed to be wrong in one direction. It's a list of ids, cheap enough to run inside the index on
  //    every request, so it skips the parts of the rule that cost: `enabled`, `deny`, the live closure. It may
  //    let through documents Leo can't read (a stale set, a deny row, a disabled grant). It must never leave out
  //    one he can: that's lost recall, with no error to tell anyone.
  // 🦉 Why not write the decision here. Two copies of the rule would drift apart. This one only narrows where
  //    search looks; `readable()` decides.
  //
  // 🚨 See the tests' summary under decideChunks.
  throw new Error(`candidateDocuments(${typeof tx}, ${principalIds.length} principals) isn't written yet`);
}

/** True when `principal` is the user or a group in their closure. */
export const holds = (userId: string, principal: SQL) =>
  sql`(${principal} = ${userId} OR ${principal} IN (SELECT acl_gc.group_id FROM group_closure acl_gc WHERE acl_gc.member_id = ${userId}))`;

/**
 * The authorisation decision, as a boolean SQL expression over a document id: Postgres is the only place it's
 * made. The user must be an enabled user principal; some enabled principal they hold (themselves, or a group in
 * their closure) must have an `allow` row on the document; none they hold may have a `deny` row; and the document
 * must be ready.
 */
export function readable(userId: string, documentId: SQL): SQL {
  // The aliases are prefixed so a caller's own `d` or `a` can't be captured by these subqueries.
  return sql`(
    EXISTS (SELECT 1 FROM principals acl_u WHERE acl_u.id = ${userId} AND acl_u.kind = 'user' AND acl_u.enabled)
    AND EXISTS (SELECT 1 FROM documents acl_d WHERE acl_d.id = ${documentId} AND acl_d.status = 'ready')
    AND EXISTS (
      SELECT 1 FROM document_acl acl_a JOIN principals acl_p ON acl_p.id = acl_a.principal_id
      WHERE acl_a.document_id = ${documentId} AND acl_a.effect = 'allow' AND acl_p.enabled
        AND ${holds(userId, sql`acl_a.principal_id`)})
    AND NOT EXISTS (
      SELECT 1 FROM document_acl acl_a
      WHERE acl_a.document_id = ${documentId} AND acl_a.effect = 'deny' AND ${holds(userId, sql`acl_a.principal_id`)})
  )`;
}

/** A candidate chunk the decision let through, with what retrieval returns about it. */
export interface DecidedChunk extends Record<string, unknown> {
  id: string;
  documentId: string;
  title: string;
  path: string;
  text: string;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
}

/**
 * The decision over search's candidates, in one statement: each chunk joined to its document at the document's
 * current version, with `readable` as a column. Allowed ones come back in the order given (the fused order), denied
 * ones as ids for the audit. A chunk of a version that isn't the document's current one is dropped silently: it's
 * stale, not denied.
 */
export async function decideChunks(
  tx: Tx,
  userId: string,
  candidateIds: readonly string[],
): Promise<{ allowed: DecidedChunk[]; denied: string[] }> {
  // 🐨 No candidates: nothing allowed, nothing denied.
  // 🐨 Otherwise one statement for all of them: each chunk joined to its document at the document's current
  //    version (`d.version = c.document_version`), selecting what a `DecidedChunk` holds plus
  //    `readable(userId, c.document_id)` as a column, `allowed`.
  // 🐨 Walk `candidateIds` in order. A chunk the statement didn't return is stale: skip it. An allowed one goes
  //    in `allowed`, without its `allowed` column. Any other goes in `denied`, as its id.
  //
  // 💰 Add `import { uuidArray } from "#learn/search/sql"`; `c.id = ANY(${uuidArray(ids)})`. Alias the columns
  //    to the field names (`c.document_id AS "documentId"`, `c.page_start AS "pageStart"`). `new Map(rows.map(
  //    (row) => [row.id, row]))` finds a row by id. `const { allowed: ok, ...chunk } = row` splits one off.
  //
  // 🦉 Why over-fetch. Retrieval hands you 60 fused candidates to return 8. The pre-filter errs wide, so some
  //    of the 60 may be denied; the 52 to spare are what keep a full 8 (and the reranker's 30) after the
  //    decision. That's what "over-fetch" means.
  // 🦉 Why a column and not a WHERE. Filter with `WHERE readable(...)` and you never learn what was refused. The
  //    audit row records the denied ids, so a stale cache or a wrong grant shows up there, not nowhere.
  // 🦉 Why one statement. Asking `canRead` per candidate is 60 round trips per question. One statement decides
  //    them all, against the same snapshot of the ACL.
  // 🦉 Why a stale chunk is silent. A re-ingested document keeps old chunks until the swap. They aren't the
  //    document's text any more, and they aren't an access question: drop them, don't count them as denied.
  // 🦉 Why the order. The reranker reads the first 30 (section 08): keep fusion's order, or depth means nothing.
  //
  // 🚨 The tests check the pre-filter (leo's 18 documents, never narrower than the decision for any of the 31
  //    users, ready only), the decision (allowed in order, denied listed, the chunk's fields, stale chunks
  //    dropped), and on the real corpus: leo's Heron search denies nothing, daniel gets the memo, and with leo's
  //    closure deleted by hand the stale set searches his old documents and all 60 candidates are denied.
  throw new Error(`decideChunks(${typeof tx}, ${userId}, ${candidateIds.length} candidates) isn't written yet`);
}

/** May this user read this document? Run it inside `withTenant` for the viewer's tenant. */
export async function canRead(tx: Tx, userId: string, documentId: string): Promise<boolean> {
  const [row] = await tx.execute<{ allowed: boolean }>(
    sql`SELECT ${readable(userId, sql`${documentId}::uuid`)} AS allowed`,
  );
  return row.allowed;
}
