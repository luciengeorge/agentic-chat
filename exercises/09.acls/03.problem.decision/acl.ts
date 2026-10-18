// 👨‍💼 The Heron memo is about a £86m acquisition the board hasn't voted on. Daniel Reyes, the CFO, should find it.
//    Leo Martin, the intern, must never see a word of it: not in an answer, not in a citation, not in a chunk
//    sent to the reranker. Every one of those paths asks one question, and this function is the only answer.

import { type SQL, sql } from "drizzle-orm";

import type { Tx } from "@/db/tenant";

import { cachedPrincipals, type PrincipalCache, sharedPrincipalCache } from "#learn/acl/principal-cache";
import { uuidArray } from "#learn/search/sql";

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
  if (principalIds.length === 0) return [];
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT DISTINCT d.id
    FROM documents d
    JOIN document_acl a ON a.document_id = d.id
    WHERE a.effect = 'allow' AND a.principal_id = ANY(${uuidArray(principalIds)}) AND d.status = 'ready'`);
  return rows.map((row) => row.id);
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
  // 🐨 Return one SQL boolean expression: four conditions joined with AND.
  //    1. The user is a user principal of this tenant, and enabled.
  //    2. The document exists here and its status is 'ready'.
  //    3. Some `allow` row on the document names an enabled principal the user holds.
  //    4. No `deny` row on the document names a principal the user holds.
  // 🐨 "A principal the user holds" is the user, or a group in their closure: `holds(userId, column)` above
  //    writes that for you.
  // 🐨 Name every table in your subqueries with an `acl_` prefix (`principals acl_u`, `documents acl_d`,
  //    `document_acl acl_a`). The tests call you from queries whose own tables are `d`, `a`, `p`, `u` and `gc`.
  //
  // 💰 sql`(EXISTS (SELECT 1 FROM ... WHERE ...) AND NOT EXISTS (...))`. `${userId}` and `${documentId}` drop
  //    in as a bound parameter and a column. `principals` has `kind` and `enabled`; `documents` has `status`;
  //    `document_acl` has `document_id`, `principal_id` and `effect`.
  //
  // 🦉 Why Postgres decides. Search, the chat's document route, citations and history all ask "may this user
  //    read this document?". If each answered in TypeScript, there would be five answers, and the one that
  //    drifts leaks. Here the answer is one expression in the same statement as the search, against the rows
  //    sync just wrote: no copy to go stale, no second round trip.
  // 🦉 Where the rows come from. Sync stamps them (`stampAcl`, step 5): each file's Graph permissions, own and
  //    inherited, become `allow` rows for the principals they name. The memo's one grant, "write to
  //    /Kestrel/Exec", is one row. The decision then joins it through the closure (step 1) at query time.
  // 🦉 Why `enabled`, checked here. A user who left (peter.hall) keeps his rows: principals are never deleted,
  //    because messages and ACLs point at them. So "disabled" must be checked on every decision, for the user
  //    and for the group a grant goes through.
  // 🦉 Why deny wins. An allow through a group and a deny on the person ("everyone in Finance except Leo") have
  //    to come out as no. So deny is a separate NOT EXISTS, over every principal the user holds.
  // 🦉 Why the prefix. A subquery sees the caller's tables too. Write `FROM documents d WHERE d.id = ${documentId}`
  //    and call it with `d.id` from a query that also says `documents d`: inside your subquery, `d.id` now means
  //    your own `d`, so `d.id = d.id` is true for every row, and the "ready" check passes for any document.
  //    That bug shipped in this app once (M1's chat history passed `d.id`), which is why the reference prefixes
  //    every alias with `acl_`.
  //
  // 📜 https://www.postgresql.org/docs/current/functions-subquery.html#FUNCTIONS-SUBQUERY-EXISTS
  //
  // 🚨 The tests check the Heron memo (daniel yes, leo no), nested groups, what each person may read of the 40
  //    documents, a disabled user, a disabled group, a deny on a group the user holds, a document that isn't
  //    ready, a user from another tenant, and the same answers whatever the caller names its tables.
  throw new Error(`readable(${userId}, ${typeof documentId}) isn't written yet`);
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
  if (candidateIds.length === 0) return { allowed: [], denied: [] };
  const rows = await tx.execute<DecidedChunk & { allowed: boolean }>(sql`
    SELECT c.id, c.document_id AS "documentId", d.title, d.path, c.text,
      c.page_start AS "pageStart", c.page_end AS "pageEnd", c.section,
      ${readable(userId, sql`c.document_id`)} AS allowed
    FROM chunks c
    JOIN documents d ON d.id = c.document_id AND d.version = c.document_version
    WHERE c.id = ANY(${uuidArray(candidateIds)})`);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const allowed: DecidedChunk[] = [];
  const denied: string[] = [];
  for (const id of candidateIds) {
    const row = byId.get(id);
    if (!row) continue;
    const { allowed: ok, ...chunk } = row;
    if (ok) allowed.push(chunk);
    else denied.push(id);
  }
  return { allowed, denied };
}

/** May this user read this document? Run it inside `withTenant` for the viewer's tenant. */
export async function canRead(tx: Tx, userId: string, documentId: string): Promise<boolean> {
  const [row] = await tx.execute<{ allowed: boolean }>(
    sql`SELECT ${readable(userId, sql`${documentId}::uuid`)} AS allowed`,
  );
  return row.allowed;
}
