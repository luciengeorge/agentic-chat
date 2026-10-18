// 👨‍💼 Finance renames its Reports folder to Board Reports. Graph's delta says one thing changed, the folder,
//    and drive sync has to work out that two reports inside now live somewhere else.

/**
 * The Graph client (`#learn/connectors/graph`) as a `Connector` (`#learn/connectors/types`), which is all drive
 * sync sees: Graph's shapes go in, the interface's come out.
 */
import type { Change, Connector, SourceFile } from "#learn/connectors/types";

import { type DeltaEntry, type DriveItem, type GraphClient, type Permission, sha256Of } from "#learn/connectors/graph";

/**
 * The directory ids an item's effective permissions grant, own and inherited alike (Graph lists both). Read and
 * write both let a person find the document, so both count. Sharing links and anything without a user or group
 * grant nobody.
 */
export function grantedIds(permissions: readonly Permission[]): string[] {
  const ids = new Set<string>();
  for (const { grantedToV2 } of permissions) {
    const id = grantedToV2.user?.id ?? grantedToV2.group?.id;
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

/** A drive item as a `SourceFile`. Only files are: a folder isn't a document. */
export function toSourceFile(item: DriveItem, path: string): SourceFile {
  const contentHash = sha256Of(item);
  if (!item.file || !contentHash) throw new Error(`item ${item.id} at ${path} isn't a file`);
  return {
    id: item.id,
    name: item.name,
    path,
    mimeType: item.file.mimeType,
    version: item.eTag,
    contentHash,
  };
}

/**
 * The Graph client as a `Connector`: Graph's drive items become `SourceFile`s, its permissions directory ids, and
 * its delta entries `Change`s (`changesFor`).
 */
export function graphConnector(graph: GraphClient): Connector {
  return {
    async *crawl() {
      for await (const page of graph.crawlPages()) yield page.map(({ item, path }) => toSourceFile(item, path));
    },

    latestCursor: () => graph.latestDeltaLink(),

    async delta(cursor) {
      const { changes, deltaLink } = await graph.delta(cursor);
      const out: Change[] = [];
      for (const entry of changes) out.push(...(await changesFor(graph, entry)));
      return { changes: out, cursor: deltaLink };
    },

    permissions: async (fileId) => grantedIds(await graph.permissions(fileId)),

    content: (fileId) => graph.content(fileId),

    async subscribe({ notificationUrl, clientState, expiresAt }) {
      const subscription = await graph.subscribe({ notificationUrl, clientState, expirationDateTime: expiresAt });
      return { id: subscription.id, expiresAt: new Date(subscription.expirationDateTime) };
    },

    async renew(subscriptionId, expiresAt) {
      const subscription = await graph.renew(subscriptionId, expiresAt);
      return { id: subscription.id, expiresAt: new Date(subscription.expirationDateTime) };
    },
  };
}

/**
 * One delta entry as our changes. Graph's delta lists a changed item without its path, and a renamed or moved
 * folder without its contents, so a changed file is read again for its path and a changed folder's files are
 * crawled again (which re-paths what a folder rename moved). A file deleted between the delta and the read is
 * skipped: the next delta brings its tombstone. The root is never a document.
 */
export async function changesFor(graph: GraphClient, entry: DeltaEntry): Promise<Change[]> {
  // 🐨 Turn one delta entry into the changes drive sync needs:
  //    - a tombstone (`entry.deleted`): one "deleted" change for its id;
  //    - the root: nothing;
  //    - a folder: a "file" change for every file under it, as they are now (crawl it);
  //    - a file: read it again for its path, and give one "file" change. If it's gone by the time you
  //      read it (404), give nothing.
  //
  // 💰 `"folder" in entry && entry.folder`, `"root" in entry && entry.root`. `graph.crawlPages(entry.id)`
  //    yields pages of `{ item, path }`. `graph.item(id)`, `itemPath(item)`, toSourceFile(item, path).
  //    `error instanceof GraphRequestError && error.status === 404`. (Import itemPath and GraphRequestError
  //    from "#learn/connectors/graph".)
  //
  // 🦉 Why a folder means its files. Graph's delta reports the item that changed. Rename /Finance/Reports
  //    and the item that changed is the folder: the two reports inside weren't touched, so delta doesn't
  //    list them, yet both their paths are now wrong. Crawling the folder again gives each file at its new
  //    path. It costs a listing, and it's the only way to see what a rename or move of a folder did.
  // 🦉 Why a file is read again. A delta entry's parentReference has no path (SharePoint leaves it out), so
  //    the entry alone can't say where the file is now. Reading the item gives the full path. A move of a
  //    file into another folder also changes who inherits access to it, which drive sync re-stamps.
  // 🦉 Why a 404 is nothing. Between the delta and your read, someone may delete the file. That's not an
  //    error: the next delta will bring its tombstone. Any other error (403, a network failure) still
  //    throws, because skipping it would lose a real change.
  // 🦉 New in this file, already written: delta() now hands each entry to you. Step 1's version skipped
  //    folders and failed on a file deleted mid-delta.
  //
  // 📜 https://learn.microsoft.com/en-us/graph/api/driveitem-delta (the notes on folders and paths)
  throw new Error(`changesFor(${graph.site}, entry ${entry.id}) isn't written yet`);
}
