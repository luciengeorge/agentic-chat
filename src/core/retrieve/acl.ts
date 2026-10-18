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
