// 👨‍💼 Kestrel's documents live in SharePoint, but drive sync never sees a SharePoint type. It speaks one small
//    interface, `Connector`, so tomorrow's Google Drive or Confluence connector plugs into the same sync. This
//    file is the adapter: Graph's shapes go in, the interface's come out.

/**
 * The Graph client (`#learn/connectors/graph`) as a `Connector` (`#learn/connectors/types`), which is all drive
 * sync sees: Graph's shapes go in, the interface's come out.
 */
import type { Change, Connector, SourceFile } from "#learn/connectors/types";

import { type DriveItem, type GraphClient, itemPath, type Permission } from "#learn/connectors/graph";

/**
 * The directory ids an item's effective permissions grant, own and inherited alike (Graph lists both). Read and
 * write both let a person find the document, so both count. Sharing links and anything without a user or group
 * grant nobody.
 */
export function grantedIds(permissions: readonly Permission[]): string[] {
  // 🐨 Collect the id of every user or group a permission grants (`grantedToV2.user` or `.group`). Each id
  //    once, sorted, so the same permissions always give the same list.
  //
  // 💰 `new Set<string>()`, then `[...ids].sort()`. `grantedToV2.user?.id ?? grantedToV2.group?.id`.
  //
  // 🦉 Why inherited grants count. Graph lists a file's effective permissions: its own, plus every folder's
  //    above it that it inherits, each marked `inheritedFrom`. The Integration Plan in /Exec has one grant
  //    of its own (Tom Whitfield may read it) and inherits /Exec's (the Exec group may write). Both let
  //    someone open the file, so both belong in its ACL. Drop the inherited ones and the whole Exec team
  //    loses the document in search.
  // 🦉 Why read and write both count. Writing implies reading. The ACL answers "who may find this", and
  //    anyone who may edit a file may find it.
  // 🦉 Why a link grants nobody. A sharing link ("anyone with the link") has no user or group in it. The
  //    app can't tell who holds the link, so it can't let anyone search for the file through it.
  //
  // 📜 https://learn.microsoft.com/en-us/graph/api/resources/permission
  //
  // 🚨 The tests check own and inherited grants, read and write, each id once and sorted, links ignored.
  throw new Error(`grantedIds(${permissions.length} permissions) isn't written yet`);
}

/** A drive item as a `SourceFile`. Only files are: a folder isn't a document. */
export function toSourceFile(item: DriveItem, path: string): SourceFile {
  // 🐨 Build the SourceFile drive sync needs from Graph's item: its id, its name, the path you're given, its
  //    MIME type, a version, and its content hash.
  // 🐨 Only a file is a SourceFile: if the item has no `file` facet (a folder) or no hash, throw.
  //
  // 💰 `item.file?.mimeType`, `item.eTag`. `sha256Of(item)`, exported by "#learn/connectors/graph", reads
  //    `item.file.hashes` (add it to the import).
  //
  // 🦉 Why the eTag is the version. Graph gives two tags. The cTag changes when the content does; the eTag
  //    changes on any change at all, a rename, a move or a sharing change included. Drive sync keeps the
  //    version to know whether a file changed since it last looked, and a file whose sharing changed has
  //    changed: someone may have lost access. (Delta entries carry no cTag at all.)
  // 🦉 Why the hash, in lower case. The version says *something* changed; the content hash says whether
  //    the *bytes* did, and only new bytes are worth parsing, chunking and embedding again. Graph writes the
  //    hash in upper-case hex, and the app stores blobs under lower case: sha256Of lowers it. A hash taken
  //    as Graph wrote it never matches what's stored, so every sync would ingest every file again.
  // 🦉 Why the id, not the path. The path changes on every rename or move; the id never does. Drive sync
  //    finds a file's document by its id, so a renamed file is the same document at a new path.
  // 🦉 New in this file, already written: graphConnector, which uses your two functions for crawl, delta
  //    and permissions.
  //
  // 📜 https://learn.microsoft.com/en-us/graph/api/resources/driveitem
  //
  // 🚨 The tests check every field against fake-workspace's own item, the hash against the sha256 of the
  //    bytes it serves, that a folder throws, and that a rename changes the path and version but not the
  //    hash.
  throw new Error(`toSourceFile(item ${item.id} at ${path}) isn't written yet`);
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
