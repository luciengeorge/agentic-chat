import { eq, inArray, sql } from "drizzle-orm";

import type { Permission } from "#learn/connectors/graph";
import type { Tx } from "@/db/tenant";

import { documentAcl, documents, principals } from "@/db/schema";

/**
 * The directory ids an item's effective permissions grant, own and inherited alike (Graph lists both). Read and
 * write both let a person find the document, so both become an `allow`. Sharing links and anything without a
 * user or group grant nobody.
 */
export function grantedIds(permissions: readonly Permission[]): string[] {
  const ids = new Set<string>();
  for (const { grantedToV2 } of permissions) {
    const id = grantedToV2.user?.id ?? grantedToV2.group?.id;
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

export interface StampResult {
  /** The document's acl_version after the stamp. */
  aclVersion: number;
  changed: boolean;
  /** Grants to ids with no principal: left out, so the ACL fails closed until the directory catches up. */
  unknown: string[];
}

/**
 * Makes the document's `document_acl` the given grants, as `allow` rows, mapped from directory ids to principals.
 * A change draws a new `acl_version` from `acl_version_seq` and stamps it on the document and on every row, so
 * versions order ACL changes across all documents. No change draws nothing. Postgres stays the only place the
 * decision is made: this only writes what the source says.
 */
export async function stampAcl(tx: Tx, documentId: string, externalIds: readonly string[]): Promise<StampResult> {
  const found = externalIds.length
    ? await tx
        .select({ id: principals.id, externalId: principals.externalId })
        .from(principals)
        .where(inArray(principals.externalId, [...externalIds]))
    : [];
  const ids = [...new Set(found.map((row) => row.id))].sort();
  const known = new Set(found.map((row) => row.externalId));
  const unknown = externalIds.filter((id) => !known.has(id));

  const [document] = await tx
    .select({ tenantId: documents.tenantId, aclVersion: documents.aclVersion })
    .from(documents)
    .where(eq(documents.id, documentId))
    .for("update");
  if (!document) throw new Error(`document ${documentId} not found`);

  const held = (
    await tx
      .select({ principalId: documentAcl.principalId, effect: documentAcl.effect })
      .from(documentAcl)
      .where(eq(documentAcl.documentId, documentId))
  )
    .filter((row) => row.effect === "allow")
    .map((row) => row.principalId)
    .sort();
  const same = held.length === ids.length && held.every((id, i) => id === ids[i]);
  if (same && document.aclVersion > 0) return { aclVersion: document.aclVersion, changed: false, unknown };

  const [{ version }] = await tx.execute<{ version: string }>(sql`SELECT nextval('acl_version_seq') AS version`);
  const aclVersion = Number(version);
  await tx.delete(documentAcl).where(eq(documentAcl.documentId, documentId));
  if (ids.length) {
    await tx.insert(documentAcl).values(
      ids.map((principalId) => ({
        tenantId: document.tenantId,
        documentId,
        principalId,
        effect: "allow",
        aclVersion,
      })),
    );
  }
  await tx.update(documents).set({ aclVersion }).where(eq(documents.id, documentId));
  return { aclVersion, changed: true, unknown };
}

/** Takes every grant away (a deleted document): nobody reaches it, and the change gets its version. */
export async function clearAcl(tx: Tx, documentId: string): Promise<void> {
  const held = await tx
    .select({ principalId: documentAcl.principalId })
    .from(documentAcl)
    .where(eq(documentAcl.documentId, documentId));
  if (held.length) await stampAcl(tx, documentId, []);
}
