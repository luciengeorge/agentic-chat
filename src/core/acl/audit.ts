/**
 * The ACL audit log (section 09.5): an append-only record of every change to who can reach what. A document's
 * ACL stamp or clear, and a direct group membership added or removed, each write one row with the state before
 * and after. The app role can insert and read rows, never update or delete them.
 *
 * Which sync run made a change rides on the transaction, as the tenant does: `setSyncRun` sets
 * `app.sync_run_id` with `SET LOCAL`, and every row written in that transaction records it. A change made outside
 * a sync (a test, a script) records none.
 */
import { sql } from "drizzle-orm";

import type { Tx } from "@/db/tenant";

/** Marks the rest of this transaction's audit rows as written by `runId`. */
export async function setSyncRun(tx: Tx, runId: string): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.sync_run_id', ${runId}, true)`);
}

const syncRun = sql`NULLIF(current_setting('app.sync_run_id', true), '')`;

export interface DocumentAclChange {
  documentId: string;
  /** Principal ids with an `allow` row, before and after. */
  before: string[];
  after: string[];
  aclVersion: number;
}

/** One row for a document's ACL change: a `clear` when nobody is left, else a `stamp`. */
export async function recordDocumentAcl(tx: Tx, tenantId: string, change: DocumentAclChange): Promise<void> {
  await tx.execute(sql`
    INSERT INTO acl_audit (tenant_id, subject, action, document_id, before, after, acl_version, sync_run_id)
    VALUES (${tenantId}, 'document', ${change.after.length ? "stamp" : "clear"}, ${change.documentId},
      ${JSON.stringify({ allow: change.before })}::jsonb, ${JSON.stringify({ allow: change.after })}::jsonb,
      ${change.aclVersion}, ${syncRun})`);
}

export interface Membership {
  groupId: string;
  memberId: string;
}

/** One row per direct membership added or removed. */
export async function recordMemberships(
  tx: Tx,
  tenantId: string,
  changes: { added: readonly Membership[]; removed: readonly Membership[] },
): Promise<void> {
  const rows = [
    ...changes.added.map((m) => ({ ...m, action: "added", before: false })),
    ...changes.removed.map((m) => ({ ...m, action: "removed", before: true })),
  ];
  if (rows.length === 0) return;
  await tx.execute(sql`
    INSERT INTO acl_audit (tenant_id, subject, action, group_id, member_id, before, after, sync_run_id)
    SELECT ${tenantId}, 'membership', r.action, r.group_id, r.member_id,
      jsonb_build_object('member', r.before), jsonb_build_object('member', NOT r.before), ${syncRun}
    FROM jsonb_to_recordset(${JSON.stringify(
      rows.map((r) => ({ action: r.action, group_id: r.groupId, member_id: r.memberId, before: r.before })),
    )}::jsonb) AS r(action text, group_id uuid, member_id uuid, before boolean)`);
}

export interface AclHistoryEntry {
  action: "stamp" | "clear";
  before: string[];
  after: string[];
  aclVersion: number;
  syncRunId: string | null;
  at: Date;
}

/** A document's ACL changes, oldest first. Run it inside `withTenant`. */
export async function aclHistory(tx: Tx, documentId: string): Promise<AclHistoryEntry[]> {
  const rows = await tx.execute<{
    action: "stamp" | "clear";
    before: { allow: string[] };
    after: { allow: string[] };
    acl_version: string;
    sync_run_id: string | null;
    created_at: string | Date;
  }>(sql`
    SELECT action, before, after, acl_version, sync_run_id, created_at FROM acl_audit
    WHERE subject = 'document' AND document_id = ${documentId}
    ORDER BY id`);
  return rows.map((row) => ({
    action: row.action,
    before: row.before.allow,
    after: row.after.allow,
    aclVersion: Number(row.acl_version),
    syncRunId: row.sync_run_id,
    at: new Date(row.created_at),
  }));
}
