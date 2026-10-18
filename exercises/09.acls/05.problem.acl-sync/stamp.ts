// 👨‍💼 Helen Marsh shares the Heron memo with Leo Martin for a day, then takes it back. Kestrel's auditors will ask
//    two questions about that: who could read the memo on Tuesday, and which sync gave Leo access. Stamping writes
//    the drive's sharing into `document_acl` on every sync. It also has to leave a trail.

import { eq } from "drizzle-orm";

import type { Tx } from "@/db/tenant";

import { documentAcl } from "@/db/schema";

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
  // 🐨 Map the directory ids to principals: look up the principals whose `externalId` is in the list. The ones
  //    found give the principal ids (sorted, each once); the ids nobody has are `unknown`.
  // 🐨 Lock the document's row (`FOR UPDATE`) and read its tenant and `aclVersion`. No row: throw.
  // 🐨 Read the principal ids it holds `allow` rows for now, sorted. If they're the same as the new ones and the
  //    document has been stamped before (`aclVersion > 0`), stop: return the old version, `changed: false`.
  // 🐨 Otherwise draw a version (`SELECT nextval('acl_version_seq')`), delete the document's rows, insert one
  //    `allow` row per principal with that version, set it on the document, and record the change with
  //    `recordDocumentAcl` (before, after, version).
  //
  // 💰 Add `inArray` and `sql` to the drizzle-orm import, `recordDocumentAcl` from "#learn/acl/audit", and
  //    `documents` and `principals` from "@/db/schema". `inArray(principals.externalId, [...ids])`;
  //    `.for("update")` after `.where(...)`; `tx.execute<{ version: string }>(sql`SELECT nextval(...) AS version`)`.
  //
  // 🦉 Postgres still decides. This function only writes what the source says: who the drive shares the file
  //    with, own and inherited, read and write alike, all as `allow`. `readable()` (step 3) reads these rows at
  //    query time, through the closure.
  // 🦉 Why unknown ids are left out. A grant to someone the directory hasn't synced yet has no principal to
  //    point at. Leaving it out fails closed: until the directory catches up, nobody gets in through it. The
  //    sync runs the directory first, so this is rare, and the report lists them.
  // 🦉 Why a version per change, from one sequence. `acl_version_seq` is shared by every document, so versions
  //    order ACL changes across the whole tenant: the memo's share with Leo is newer than anything before it.
  //    Every retrieval writes the sequence's high-water mark in its audit row, so "what could Leo see at 10:02?"
  //    has an answer: the rows with a version at or below that mark.
  // 🦉 Why no version for no change. The classic slip is to delete and re-insert on every sync. The decision
  //    would still be right, but every document would look changed every few minutes, the audit log would fill
  //    with nothing, and the version could no longer tell anyone when access really changed.
  // 🦉 Why a never-stamped document is a change even to nobody. `acl_version` 0 means "not stamped yet". A file
  //    shared with no one still gets a version, so "stamped" and "shared with nobody" can be told apart.
  // 🦉 Why lock the row. Two syncs of the same file (a webhook's delta and the periodic one) would both compare,
  //    both draw, and the slower one could write the older sharing last. The lock makes the second wait and
  //    compare against the first's rows.
  // 🦉 Who calls it. `applyFile` in the drive sync (section 02), for every file it sees, after `setSyncRun` set
  //    the run id on the transaction: `recordDocumentAcl` writes that id on the audit row. The app role may
  //    insert and read `acl_audit`, never update or delete it.
  //
  // 📜 https://learn.microsoft.com/en-us/graph/api/driveitem-list-permissions
  //
  // 🚨 The tests check a full sync of the 40 documents (40 versions, 40 audit rows naming the run, every row
  //    allow and at the document's version), the memo's one row for /Kestrel/Exec, no version for a sync that
  //    changes nothing, a share with leo.martin (a new highest version, before and after recorded, canRead now
  //    true), an unknown grant left out and reported, and a version for a document shared with nobody.
  throw new Error(`stampAcl(${typeof tx}, ${documentId}, ${externalIds.length} grants) isn't written yet`);
}

/** Takes every grant away (a deleted document): nobody reaches it, and the change gets its version. */
export async function clearAcl(tx: Tx, documentId: string): Promise<void> {
  const held = await tx
    .select({ principalId: documentAcl.principalId })
    .from(documentAcl)
    .where(eq(documentAcl.documentId, documentId));
  if (held.length) await stampAcl(tx, documentId, []);
}
