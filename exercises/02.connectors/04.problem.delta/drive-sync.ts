// 👨‍💼 Kestrel's people rename, reshare and replace files all day. Crawling the whole drive after each change
//    would be 20 requests and 40 files written to learn that one file moved. Graph can say what changed
//    since a bookmark instead, and call the app when something does.

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
  // 🐨 Start a report from a cursor for "from now on" (source.latestCursor()), taken before anything else.
  // 🐨 Then crawl: for every page the source yields, apply every file (applyFile writes its document and
  //    stamps its ACL, and fills in the report). Return the report: its cursor is where the next delta
  //    starts.
  //
  // 💰 emptyReport(cursor). `for await (const page of source.crawl())`.
  //
  // 🦉 Why the cursor comes first. A crawl of a big drive takes minutes, and people keep working. Say
  //    Tom uploads a new budget while the crawl is in Legal, after it has passed Finance. If you take the
  //    cursor *after* the crawl, it starts after Tom's upload, and no delta will ever show it: the old
  //    budget stays in search until the next full crawl. Taken *before*, the next delta replays every
  //    change since the crawl began. Some of them the crawl already saw; applying a change twice is
  //    harmless, because applyFile writes what the file is now, not what changed.
  //
  // 📜 https://learn.microsoft.com/en-us/graph/api/driveitem-delta (the `token=latest` trick)
  //
  // 🚨 (with deltaSync, below) The tests check that a full sync writes all 40 files, that a second one
  //    changes nothing, that a file changed during the crawl shows up in the next delta, and that a delta
  //    applies a rename, new content and a sharing change and hands back the next cursor.
  throw new Error(`fullSync(tx, ${tenantId}, source) isn't written yet`, { cause: { tx, source } });
}

/**
 * The changes since `cursor`. Throws `ResyncRequiredError` when the cursor has expired: the caller runs a full
 * sync instead.
 */
export async function deltaSync(tx: Tx, tenantId: string, source: Connector, cursor: string): Promise<DriveSyncReport> {
  // 🐨 Ask the source what changed since `cursor`. Start a report from the cursor it hands back (where the
  //    next delta starts), apply each changed file, and return the report. Tombstones (deleted files) are
  //    step 5's: skip them for now.
  // 🐨 Don't catch ResyncRequiredError. It has to reach the caller, which runs a full sync instead.
  //
  // 💰 `const { changes, cursor: next } = await source.delta(cursor)`. `change.type === "file"`.
  //
  // 🦉 Why delta. A full crawl of Kestrel's drive is 20 requests and 40 files written; a delta after one
  //    rename is one or two requests and one file. On a drive of 30,000 files, that's the difference
  //    between minutes and milliseconds, so delta is what runs every time something changes.
  // 🦉 Why the cursor comes back in the report. A cursor is a bookmark into the source's change log.
  //    Each delta hands back the next one; the caller saves it (in `sync_state`) only after the changes
  //    are written, in the same transaction. Crash before the commit and the old cursor is still saved,
  //    so the same changes are read again: nothing is lost, and nothing is applied half.
  // 🦉 Why a webhook only says "look again". Graph's change notifications carry no file, just the
  //    subscription and a secret (`clientState`) to prove they're from Graph. The app checks those and
  //    runs a delta (src/routes/api/webhooks/-workspace.ts). So a missed notification costs nothing that
  //    the next delta, or the hourly timer, won't fix.
  // 🦉 Why an expired cursor throws. Graph only keeps so much history; a cursor older than that gets a
  //    410, which the client turns into ResyncRequiredError. Swallow it and the drive silently stops
  //    syncing for good.
  // 🦉 New in this file, already written: the report, and applyFile, which creates or updates a file's
  //    document (a new version to ingest only when its bytes changed) and stamps its ACL.
  //
  // 📜 https://learn.microsoft.com/en-us/graph/webhooks
  throw new Error(`deltaSync(tx, ${tenantId}, source, ${cursor}) isn't written yet`, { cause: { tx, source } });
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
