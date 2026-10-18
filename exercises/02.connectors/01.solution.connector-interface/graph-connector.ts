/**
 * The Graph client (`#learn/connectors/graph`) as a `Connector` (`#learn/connectors/types`), which is all drive
 * sync sees: Graph's shapes go in, the interface's come out.
 */
import type { Change, Connector, SourceFile } from "#learn/connectors/types";

import { type DriveItem, type GraphClient, itemPath, type Permission, sha256Of } from "#learn/connectors/graph";

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
 * its delta entries `Change`s.
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
      for (const entry of changes) {
        if (entry.deleted) {
          out.push({ type: "deleted", id: entry.id });
        } else if (!("folder" in entry && entry.folder) && !("root" in entry && entry.root)) {
          // A delta entry has no path, so read the file again for it.
          const item = await graph.item(entry.id);
          out.push({ type: "file", file: toSourceFile(item, itemPath(item)) });
        }
      }
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
