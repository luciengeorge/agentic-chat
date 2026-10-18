// 👨‍💼 Leo in accounts payable deletes a scanned invoice batch from SharePoint because it holds a supplier's
//    bank details by mistake. Until the app notices, Kestrel's assistant keeps quoting it. And when Finance
//    renames its Reports folder, the two reports inside keep their old paths. Deletes and moves are where a
//    sync that's right most of the time is wrong in ways people notice.

import { and, eq, ne, notInArray } from "drizzle-orm";

import type { Connector, SourceFile } from "#learn/connectors/types";
import type { Tx } from "@/db/tenant";

import { stampAcl } from "#learn/acl/stamp";
import { documents } from "@/db/schema";

/** `documents.source` for the drive. */
export const SOURCE = "workspace";

export interface IngestRequest {
  documentId: string;
  version: number;
}

export interface DriveSyncReport {
  files: number;
  created: number;
  /** Renamed or moved: the path or title changed, the content didn't. */
  moved: number;
  /** New content: a new version to ingest. */
  changed: number;
  deleted: number;
  aclChanged: number;
  /** Documents to ingest, at the version the sync left them. */
  ingest: IngestRequest[];
  /** Grants to principals the directory doesn't have yet, left out of the ACLs. */
  unknownPrincipals: string[];
  /** Where the next delta starts. */
  cursor: string;
}

export function emptyReport(cursor: string): DriveSyncReport {
  return {
    files: 0,
    created: 0,
    moved: 0,
    changed: 0,
    deleted: 0,
    aclChanged: 0,
    ingest: [],
    unknownPrincipals: [],
    cursor,
  };
}

/**
 * Every file in the source, written to `documents` with its ACL; documents the source no longer has are deleted.
 * The cursor is taken before the crawl, so a change that lands during it is read again by the next delta, and
 * applying it twice changes nothing.
 */
export async function fullSync(tx: Tx, tenantId: string, source: Connector): Promise<DriveSyncReport> {
  const report = emptyReport(await source.latestCursor());
  const seen: string[] = [];
  for await (const page of source.crawl()) {
    for (const file of page) {
      seen.push(file.id);
      await applyFile(tx, tenantId, source, file, report);
    }
  }
  const gone = await tx
    .select({ externalId: documents.externalId })
    .from(documents)
    .where(
      and(
        eq(documents.source, SOURCE),
        ne(documents.status, "deleted"),
        seen.length ? notInArray(documents.externalId, seen) : undefined,
      ),
    );
  for (const { externalId } of gone) await deleteFile(tx, externalId, report);
  return report;
}

/**
 * The changes since `cursor`. Throws `ResyncRequiredError` when the cursor has expired: the caller runs a full
 * sync instead.
 */
export async function deltaSync(tx: Tx, tenantId: string, source: Connector, cursor: string): Promise<DriveSyncReport> {
  const { changes, cursor: next } = await source.delta(cursor);
  const report = emptyReport(next);
  for (const change of changes) {
    if (change.type === "deleted") await deleteFile(tx, change.id, report);
    else await applyFile(tx, tenantId, source, change.file, report);
  }
  return report;
}

/** Creates or updates the file's document, and stamps its ACL. New content means a new version to ingest. */
export async function applyFile(
  tx: Tx,
  tenantId: string,
  source: Connector,
  file: SourceFile,
  report: DriveSyncReport,
): Promise<void> {
  report.files += 1;
  const fields = {
    title: file.name,
    path: file.path,
    mimeType: file.mimeType,
    sourceVersion: file.version,
    contentHash: file.contentHash,
  };

  const [existing] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.source, SOURCE), eq(documents.externalId, file.id)))
    .for("update");

  let documentId: string;
  if (!existing) {
    const [row] = await tx
      .insert(documents)
      .values({ tenantId, source: SOURCE, externalId: file.id, version: 1, status: "pending", ...fields })
      .returning({ id: documents.id });
    documentId = row.id;
    report.created += 1;
    report.ingest.push({ documentId, version: 1 });
  } else {
    documentId = existing.id;
    // A failed ingest is tried again, as a deleted document comes back.
    const newContent =
      existing.contentHash !== file.contentHash || existing.status === "deleted" || existing.status === "failed";
    const version = newContent ? existing.version + 1 : existing.version;
    if (existing.path !== file.path || existing.title !== file.name) report.moved += 1;
    await tx
      .update(documents)
      .set({ ...fields, version, deletedAt: null, ...(newContent ? { status: "pending" } : {}) })
      .where(eq(documents.id, documentId));
    if (newContent) {
      report.changed += 1;
      report.ingest.push({ documentId, version });
    }
  }

  const stamp = await stampAcl(tx, documentId, await source.permissions(file.id));
  if (stamp.changed) report.aclChanged += 1;
  for (const id of stamp.unknown) if (!report.unknownPrincipals.includes(id)) report.unknownPrincipals.push(id);
}

/** The document leaves search at once: its chunks and ACL go, and it's marked deleted. The blob stays. */
async function deleteFile(tx: Tx, externalId: string, report: DriveSyncReport): Promise<void> {
  // 🐨 Find the document for this source id (lock its row, as applyFile does). If there's none, or it's
  //    already deleted, there's nothing to do.
  // 🐨 Otherwise take it out of search, all inside this transaction: delete its chunks, clear its ACL,
  //    then mark it deleted (status "deleted", deletedAt now). Count it in the report.
  // 🐨 Leave its blob alone.
  //
  // 💰 `tx.select({ id: documents.id, status: documents.status }).from(documents).where(and(eq(...),
  //    eq(...))).for("update")`. `tx.delete(chunks).where(eq(chunks.documentId, id))`. clearAcl(tx, id).
  //    `tx.update(documents).set({ ... }).where(eq(documents.id, id))`. Import `clearAcl` from
  //    "#learn/acl/stamp" and `chunks` from "@/db/schema".
  //
  // 🦉 Why the chunks go at once. Search reads chunks, not documents. A document marked "deleted" with
  //    its chunks still there keeps answering questions. Deleting them in the same transaction means
  //    there's no moment when the file is gone from SharePoint and still quoted by the assistant.
  // 🦉 Why the ACL is cleared too. The ACL is who may read the document; nobody may read one that doesn't
  //    exist any more. Clearing it also bumps its acl_version, so anything cached about who could see it
  //    is known to be stale (section 09).
  // 🦉 Why the blob stays. The blob is keyed by content hash, and another document may hold the same
  //    bytes. If the file comes back (restored from SharePoint's recycle bin), applyFile sees a deleted
  //    document and ingests it again; the bytes may still be there.
  // 🦉 Why "already deleted" is nothing. A delete can arrive twice: a tombstone, then a full sync's sweep
  //    that doesn't see the file either. The second must change nothing, or the report and the audit log
  //    would count it twice.
  // 🦉 New in this file, already written: deltaSync hands tombstones to you, and fullSync sweeps away the
  //    documents its crawl didn't find, through you.
  //
  // 🚨 (with changesFor, in graph-connector.ts) The tests check that a deleted file's chunks and ACL go
  //    and its document is marked deleted, that its blob stays, that deleting twice counts once, that a
  //    full sync deletes what the source no longer has, and that a folder rename or a move re-paths files.
  throw new Error(`deleteFile(${externalId}) isn't written yet`, { cause: { tx, report } });
}
