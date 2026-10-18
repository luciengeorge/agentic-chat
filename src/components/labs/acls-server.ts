/**
 * The ACL lab's server side (section 09): one real retrieval as any user of either tenant, and what decided it. It
 * shows another person's access, so the route refuses it outside dev. Everything about the picked user is read
 * inside their tenant's transaction, as the app role, through `#learn/*` (the learner's closure, cache, decision and
 * stamping while a 09 step is active). The owner's pool is used for two things only: listing the users to pick
 * from, and counting the other tenant's documents, to show that none of them is visible from this tenant.
 */
import { sql } from "drizzle-orm";

import type { RetrieveDeps } from "#learn/retrieve/retrieve";
import type { Tx } from "@/db/tenant";

import { candidateDocuments, readable, viewerPrincipals } from "#learn/retrieve/acl";
import { createRetrieve } from "#learn/retrieve/retrieve";

type Exec = Pick<Tx, "execute">;

export interface AclLabDeps {
  retrieve: RetrieveDeps;
  /** The owner's pool, which RLS doesn't bind. */
  owner: Exec;
}

export type AclLabUser = {
  tenantId: string;
  tenant: string;
  userId: string;
  username: string;
  name: string;
  enabled: boolean;
};

/** Every user principal of every tenant, by tenant then name. */
export async function aclLabUsers(owner: Exec): Promise<AclLabUser[]> {
  return owner.execute<AclLabUser>(sql`
    SELECT o.id AS "tenantId", o.slug AS tenant, p.id AS "userId", p.name AS username,
      p.display_name AS name, p.enabled
    FROM principals p JOIN organization o ON o.id = p.tenant_id
    WHERE p.kind = 'user'
    ORDER BY o.slug DESC, p.name`);
}

export type AclLabChunk = {
  id: string;
  title: string;
  path: string;
  pageStart: number | null;
  pageEnd: number | null;
  text: string;
};

export interface AclLabRun {
  user: { username: string; name: string; enabled: boolean; tenant: string };
  /** The groups the closure puts the user in, nearest first. */
  groups: { name: string; depth: number }[];
  /** Ready documents in the tenant, the ones the user may read, and the ones the pre-filter searched. */
  documents: { total: number; readable: number; candidates: number };
  returned: AclLabChunk[];
  denied: AclLabChunk[];
  audit: { id: string; returned: number; denied: number; aclVersion: number; queryHash: string; at: string };
  /** Every other tenant: its documents (not deleted) as the owner counts them, and as this tenant's transaction
   * sees them. */
  walls: { tenant: string; documents: number; visibleFromHere: number }[];
}

const snippet = (text: string) => text.slice(0, 240);

export async function aclLabRun(
  deps: AclLabDeps,
  pick: { tenantId: string; userId: string },
  question: string,
): Promise<AclLabRun> {
  const before = await deps.retrieve.withTenant(pick.tenantId, async (tx) => {
    const [user] = await tx.execute<{ username: string; name: string; enabled: boolean; tenant: string }>(sql`
      SELECT p.name AS username, p.display_name AS name, p.enabled, o.slug AS tenant
      FROM principals p JOIN organization o ON o.id = p.tenant_id
      WHERE p.id = ${pick.userId} AND p.kind = 'user'`);
    if (!user) throw new Error("No such user in that tenant.");
    const groups = await tx.execute<{ name: string; depth: number }>(sql`
      SELECT p.name, gc.depth FROM group_closure gc JOIN principals p ON p.id = gc.group_id
      WHERE gc.member_id = ${pick.userId} ORDER BY gc.depth, p.name`);
    const { principalIds } = await viewerPrincipals(tx, pick.userId, null);
    const candidates = await candidateDocuments(tx, principalIds);
    const [counts] = await tx.execute<{ total: number; readable: number }>(sql`
      SELECT count(*) FILTER (WHERE doc.status = 'ready')::int AS total,
        count(*) FILTER (WHERE ${readable(pick.userId, sql`doc.id`)})::int AS readable
      FROM documents doc`);
    return { user, groups, documents: { ...counts, candidates: candidates.length } };
  });

  const retrieval = await createRetrieve(deps.retrieve)(pick, question);

  const after = await deps.retrieve.withTenant(pick.tenantId, async (tx) => {
    const [row] = await tx.execute<{
      id: string;
      returned: number;
      denied_ids: string[];
      acl_version: string;
      query_hash: string;
      created_at: string | Date;
    }>(sql`
      SELECT id, cardinality(returned_ids)::int AS returned, denied_ids, acl_version, query_hash, created_at
      FROM retrieval_audit WHERE id = ${retrieval.auditId}`);
    const denied = row.denied_ids.length
      ? await tx.execute<AclLabChunk>(sql`
          SELECT c.id, doc.title, doc.path, c.page_start AS "pageStart", c.page_end AS "pageEnd", c.text
          FROM chunks c JOIN documents doc ON doc.id = c.document_id
          WHERE c.id = ANY(${`{${row.denied_ids.join(",")}}`}::uuid[])`)
      : [];
    const order = new Map(row.denied_ids.map((id, i) => [id, i]));
    const others = await deps.owner.execute<{ id: string; slug: string; documents: number }>(sql`
      SELECT o.id, o.slug,
        (SELECT count(*)::int FROM documents d WHERE d.tenant_id = o.id AND d.status <> 'deleted') AS documents
      FROM organization o WHERE o.id <> ${pick.tenantId} ORDER BY o.slug`);
    const walls = [];
    for (const other of others) {
      const [seen] = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM documents WHERE tenant_id = ${other.id}`,
      );
      walls.push({ tenant: other.slug, documents: other.documents, visibleFromHere: seen.n });
    }
    return {
      audit: {
        id: row.id,
        returned: row.returned,
        denied: row.denied_ids.length,
        aclVersion: Number(row.acl_version),
        queryHash: row.query_hash,
        at: new Date(row.created_at).toISOString(),
      },
      denied: denied
        .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
        .map((chunk) => ({ ...chunk, text: snippet(chunk.text) })),
      walls,
    };
  });

  return {
    ...before,
    returned: retrieval.chunks.map((chunk) => ({
      id: chunk.id,
      title: chunk.title,
      path: chunk.path,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      text: snippet(chunk.text),
    })),
    ...after,
  };
}
