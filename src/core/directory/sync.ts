import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

import type { GraphClient } from "#learn/connectors/graph";
import type { Tx } from "@/db/tenant";

import { groupClosure, groupMembers, principals } from "@/db/schema";

import { computeClosure, type Edge } from "./closure";

export interface DirectoryPrincipal {
  /** The directory's id. Entra ids are uuids, so it's also the principal's id here. */
  id: string;
  kind: "user" | "group";
  /** The username for a user, the path for a group. */
  name: string;
  displayName: string;
  email: string | null;
  enabled: boolean;
}

export interface DirectorySnapshot {
  principals: DirectoryPrincipal[];
  /** Direct memberships, by directory id. */
  edges: Edge[];
}

export interface DirectorySyncResult {
  principals: number;
  disabled: string[];
  members: { added: number; removed: number };
  closure: { added: number; removed: number; changed: number };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Users, groups and each group's direct members, read from the directory. The closure is ours to build. */
export async function fetchDirectory(graph: GraphClient): Promise<DirectorySnapshot> {
  const [users, groups] = await Promise.all([graph.users(), graph.groups()]);
  const found: DirectoryPrincipal[] = [
    ...users.map((user) => ({
      id: user.id,
      kind: "user" as const,
      name: user.userPrincipalName.split("@")[0],
      displayName: user.displayName,
      email: user.userPrincipalName,
      enabled: user.accountEnabled,
    })),
    ...groups.map((group) => ({
      id: group.id,
      kind: "group" as const,
      name: group.displayName,
      displayName: group.displayName,
      email: null,
      enabled: true,
    })),
  ];
  for (const principal of found) {
    if (!UUID.test(principal.id)) throw new Error(`directory id ${principal.id} (${principal.name}) isn't a uuid`);
  }
  const known = new Set(found.map((principal) => principal.id));
  const edges: Edge[] = [];
  for (const group of groups) {
    for (const member of await graph.members(group.id)) {
      // A member the listings didn't return (another site's, or added since) has no principal to point at.
      if (known.has(member.id)) edges.push({ groupId: group.id, memberId: member.id });
    }
  }
  return { principals: found, edges };
}

/**
 * Makes the tenant's principals, direct memberships and closure match the snapshot, in the caller's
 * transaction. A principal the directory no longer lists is disabled, not deleted: ACL rows and conversations
 * point at it. Membership and `enabled` changes leave `acl_version_seq` alone (an M0 decision): they change who
 * a document's ACL reaches, not the ACL.
 */
export async function applyDirectory(
  tx: Tx,
  tenantId: string,
  snapshot: DirectorySnapshot,
  now: Date,
): Promise<DirectorySyncResult> {
  if (snapshot.principals.length) {
    await tx
      .insert(principals)
      .values(snapshot.principals.map((p) => ({ ...p, tenantId, externalId: p.id, syncedAt: now })))
      .onConflictDoUpdate({
        target: [principals.tenantId, principals.kind, principals.externalId],
        set: {
          name: sql`excluded.name`,
          displayName: sql`excluded.display_name`,
          email: sql`excluded.email`,
          enabled: sql`excluded.enabled`,
          syncedAt: sql`excluded.synced_at`,
        },
      });
  }
  const listed = snapshot.principals.map((p) => p.id);
  const disabled = await tx
    .update(principals)
    .set({ enabled: false, syncedAt: now })
    .where(
      and(
        eq(principals.tenantId, tenantId),
        eq(principals.enabled, true),
        listed.length ? notInArray(principals.id, listed) : undefined,
      ),
    )
    .returning({ name: principals.name });

  const members = await replace(
    tx,
    groupMembers,
    tenantId,
    snapshot.edges.map((edge) => ({ ...edge, depth: 0 })),
    false,
  );
  const closure = await replace(tx, groupClosure, tenantId, computeClosure(snapshot.edges), true);

  return {
    principals: snapshot.principals.length,
    disabled: disabled.map((row) => row.name),
    members: { added: members.added, removed: members.removed },
    closure,
  };
}

type PairTable = typeof groupMembers | typeof groupClosure;

/** Brings a (group, member) table to `want`: deletes what's gone, adds what's new, and fixes changed depths. */
async function replace(
  tx: Tx,
  table: PairTable,
  tenantId: string,
  want: { groupId: string; memberId: string; depth: number }[],
  withDepth: boolean,
) {
  const key = (row: { groupId: string; memberId: string }) => `${row.groupId}|${row.memberId}`;
  const have = new Map(
    (
      await tx
        .select({
          groupId: table.groupId,
          memberId: table.memberId,
          depth: withDepth ? groupClosure.depth : sql<number>`0`,
        })
        .from(table)
    ).map((row) => [key(row), row]),
  );
  const wanted = new Map(want.map((row) => [key(row), row]));

  const gone = [...have.values()].filter((row) => !wanted.has(key(row)));
  const added = [...wanted.values()].filter((row) => !have.has(key(row)));
  const changed = [...wanted.values()].filter((row) => {
    const held = have.get(key(row));
    return held !== undefined && Number(held.depth) !== row.depth;
  });

  for (const row of gone) {
    await tx.delete(table).where(and(eq(table.groupId, row.groupId), eq(table.memberId, row.memberId)));
  }
  if (added.length) {
    const values = added.map(({ groupId, memberId, depth }) =>
      withDepth ? { tenantId, groupId, memberId, depth } : { tenantId, groupId, memberId },
    );
    for (let i = 0; i < values.length; i += 1000) {
      await tx.insert(table).values(values.slice(i, i + 1000) as never);
    }
  }
  for (const row of changed) {
    await tx
      .update(groupClosure)
      .set({ depth: row.depth })
      .where(and(eq(groupClosure.groupId, row.groupId), eq(groupClosure.memberId, row.memberId)));
  }
  return { added: added.length, removed: gone.length, changed: changed.length };
}

/** For the closure check in tests: who the closure puts in a group, by principal id. */
export async function closureMembers(tx: Tx, groupId: string): Promise<string[]> {
  const rows = await tx
    .select({ memberId: groupClosure.memberId })
    .from(groupClosure)
    .where(inArray(groupClosure.groupId, [groupId]));
  return rows.map((row) => row.memberId).sort();
}
