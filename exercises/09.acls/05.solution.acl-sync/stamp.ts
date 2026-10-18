import { eq, inArray, sql } from "drizzle-orm";

import type { Tx } from "@/db/tenant";

import { recordDocumentAcl } from "#learn/acl/audit";
import { documentAcl, documents, principals } from "@/db/schema";

/** Graph's permissions as directory ids: the Graph connector's job, kept here for its callers. */
export { grantedIds } from "#learn/connectors/graph";

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
 * versions order ACL changes across all documents, and writes the change to the audit log (`#learn/acl/audit`).
 * No change draws nothing. Postgres stays the only place the decision is made: this only writes what the source
 * says.
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
  await recordDocumentAcl(tx, document.tenantId, { documentId, before: held, after: ids, aclVersion });
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
