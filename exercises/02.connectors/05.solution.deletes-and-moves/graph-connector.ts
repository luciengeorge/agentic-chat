/**
 * The Graph client (`#learn/connectors/graph`) as a `Connector` (`#learn/connectors/types`), which is all drive
 * sync sees: Graph's shapes go in, the interface's come out.
 */
import type { Change, Connector, SourceFile } from "#learn/connectors/types";

import {
  type DeltaEntry,
  type DriveItem,
  type GraphClient,
  GraphRequestError,
  itemPath,
  type Permission,
  sha256Of,
} from "#learn/connectors/graph";

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
  if (entry.deleted) return [{ type: "deleted", id: entry.id }];
  if ("root" in entry && entry.root) return [];
  if ("folder" in entry && entry.folder) {
    const out: Change[] = [];
    for await (const page of graph.crawlPages(entry.id)) {
      for (const { item, path } of page) out.push({ type: "file", file: toSourceFile(item, path) });
    }
    return out;
  }
  let item: DriveItem;
  try {
    item = await graph.item(entry.id);
  } catch (error) {
    if (error instanceof GraphRequestError && error.status === 404) return [];
    throw error;
  }
  return [{ type: "file", file: toSourceFile(item, itemPath(item)) }];
}
