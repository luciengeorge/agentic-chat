import { and, eq, ne, notInArray } from "drizzle-orm";

import type { Tx } from "@/db/tenant";

import { clearAcl, grantedIds, stampAcl } from "#learn/acl/stamp";
import { chunks, documents } from "@/db/schema";

import { type DriveItem, type GraphClient, GraphRequestError, itemPath, sha256Of } from "./graph";

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
  deltaLink: string;
}

function emptyReport(deltaLink: string): DriveSyncReport {
  return {
    files: 0,
    created: 0,
    moved: 0,
    changed: 0,
    deleted: 0,
    aclChanged: 0,
    ingest: [],
    unknownPrincipals: [],
    deltaLink,
  };
}

/**
 * Every file in the drive, written to `documents` with its ACL; documents the drive no longer has are deleted.
 * The delta link is taken before the crawl, so a change that lands during it is read again by the next delta,
 * and applying it twice changes nothing.
 */
export async function fullSync(tx: Tx, tenantId: string, graph: GraphClient): Promise<DriveSyncReport> {
  const report = emptyReport(await graph.latestDeltaLink());
  const seen: string[] = [];
  for await (const { item, path } of graph.crawl()) {
    seen.push(item.id);
    await applyFile(tx, tenantId, graph, item, path, report);
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
 * The changes since `deltaLink`. Delta lists a changed item without its path, and a renamed or moved folder
 * without its contents, so a file is read again for its path and a folder's files are crawled again. Throws
 * `ResyncRequiredError` (410) when the link has expired: the caller runs a full sync instead.
 */
export async function deltaSync(
  tx: Tx,
  tenantId: string,
  graph: GraphClient,
  deltaLink: string,
): Promise<DriveSyncReport> {
  const { changes, deltaLink: next } = await graph.delta(deltaLink);
  const report = emptyReport(next);
  for (const change of changes) {
    if (change.deleted) {
      await deleteFile(tx, change.id, report);
    } else if ("root" in change && change.root) {
      continue;
    } else if ("folder" in change && change.folder) {
      for await (const { item, path } of graph.crawl(change.id))
        await applyFile(tx, tenantId, graph, item, path, report);
    } else {
      let item: DriveItem;
      try {
        item = await graph.item(change.id);
      } catch (error) {
        // Deleted since the delta was read: the next delta brings its tombstone.
        if (error instanceof GraphRequestError && error.status === 404) continue;
        throw error;
      }
      await applyFile(tx, tenantId, graph, item, itemPath(item), report);
    }
  }
  return report;
}

/** Creates or updates the file's document, and stamps its ACL. New content means a new version to ingest. */
async function applyFile(
  tx: Tx,
  tenantId: string,
  graph: GraphClient,
  item: DriveItem,
  path: string,
  report: DriveSyncReport,
): Promise<void> {
  const sha256 = sha256Of(item);
  if (!item.file || !sha256) throw new Error(`item ${item.id} at ${path} isn't a file`);
  report.files += 1;
  const fields = {
    title: item.name,
    path,
    mimeType: item.file.mimeType,
    sourceVersion: item.eTag,
    contentHash: sha256,
  };

  const [existing] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.source, SOURCE), eq(documents.externalId, item.id)))
    .for("update");

  let documentId: string;
  if (!existing) {
    const [row] = await tx
      .insert(documents)
      .values({ tenantId, source: SOURCE, externalId: item.id, version: 1, status: "pending", ...fields })
      .returning({ id: documents.id });
    documentId = row.id;
    report.created += 1;
    report.ingest.push({ documentId, version: 1 });
  } else {
    documentId = existing.id;
    // A failed ingest is tried again, as a deleted document comes back.
    const newContent = existing.contentHash !== sha256 || existing.status === "deleted" || existing.status === "failed";
    const version = newContent ? existing.version + 1 : existing.version;
    if (existing.path !== path || existing.title !== item.name) report.moved += 1;
    await tx
      .update(documents)
      .set({ ...fields, version, deletedAt: null, ...(newContent ? { status: "pending" } : {}) })
      .where(eq(documents.id, documentId));
    if (newContent) {
      report.changed += 1;
      report.ingest.push({ documentId, version });
    }
  }

  const stamp = await stampAcl(tx, documentId, grantedIds(await graph.permissions(item.id)));
  if (stamp.changed) report.aclChanged += 1;
  for (const id of stamp.unknown) if (!report.unknownPrincipals.includes(id)) report.unknownPrincipals.push(id);
}

/** The document leaves search at once: its chunks and ACL go, and it's marked deleted. The blob stays. */
async function deleteFile(tx: Tx, externalId: string, report: DriveSyncReport): Promise<void> {
  const [document] = await tx
    .select({ id: documents.id, status: documents.status })
    .from(documents)
    .where(and(eq(documents.source, SOURCE), eq(documents.externalId, externalId)))
    .for("update");
  if (!document || document.status === "deleted") return;
  await tx.delete(chunks).where(eq(chunks.documentId, document.id));
  await clearAcl(tx, document.id);
  await tx.update(documents).set({ status: "deleted", deletedAt: new Date() }).where(eq(documents.id, document.id));
  report.deleted += 1;
}
