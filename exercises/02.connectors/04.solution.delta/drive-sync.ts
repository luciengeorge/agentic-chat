import { and, eq } from "drizzle-orm";

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
 * Every file in the source, written to `documents` with its ACL. The cursor is taken before the crawl, so a change
 * that lands during it is read again by the next delta, and applying it twice changes nothing.
 */
export async function fullSync(tx: Tx, tenantId: string, source: Connector): Promise<DriveSyncReport> {
  const report = emptyReport(await source.latestCursor());
  for await (const page of source.crawl()) {
    for (const file of page) await applyFile(tx, tenantId, source, file, report);
  }
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
    // Deletes come in step 5: for now a tombstone is skipped.
    if (change.type === "file") await applyFile(tx, tenantId, source, change.file, report);
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
