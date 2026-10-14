import type { Context, Hono } from "hono";

/** The Graph-shaped drive a connector sees: `/v1.0/sites/{site}/drive/...`. */
import { readFile } from "node:fs/promises";
import { v5 as uuidv5 } from "uuid";

import type { Runtime } from "./app";

import { iso } from "./clock";
import { GraphError, badRequest } from "./errors";
import { type Json, decodeToken, encodeToken, keysetPage, link, query, siteAccess, top } from "./http";
import { type Effective, type Item, NAMESPACE, type Site } from "./site";

const CONTROL_APP = { id: uuidv5("control", NAMESPACE), displayName: "fake-workspace" };

function identity(site: Site, userId: string | null): Json {
  if (userId === null) return { application: CONTROL_APP };
  return { user: { id: userId, displayName: site.users.get(userId) } };
}

/**
 * A driveItem. In delta, parentReference has no path and files have no cTag, as in SharePoint:
 * renaming a folder doesn't return its descendants, so paths there would go stale.
 */
export function driveItem(site: Site, item: Item, delta = false): Json {
  const body: Json = { id: item.id, name: item.name, eTag: item.etag };
  if (!item.folder && !delta) body.cTag = item.ctag;
  Object.assign(body, {
    createdDateTime: iso(item.created),
    lastModifiedDateTime: iso(item.modified),
    size: site.size(item),
    createdBy: identity(site, item.createdBy),
    lastModifiedBy: identity(site, item.modifiedBy),
  });
  if (item.parentId === null) {
    body.root = {};
  } else {
    const parent = site.items.get(item.parentId)!;
    body.parentReference = delta ? { id: parent.id } : { id: parent.id, path: site.drivePath(parent) };
  }
  if (item.folder) {
    body.folder = { childCount: site.children(item).length };
  } else {
    body.file = { mimeType: item.mimeType, hashes: { sha256Hash: (item.sha256 ?? "").toUpperCase() } };
  }
  return body;
}

export function permission(site: Site, item: Item, { grant, source }: Effective): Json {
  const grantedBy = source ?? item;
  const key = `permission:${grantedBy.id}:${grant.principal_type}:${grant.principal_id}`;
  const grantedToV2 =
    grant.principal_type === "user"
      ? { user: { id: grant.principal_id, displayName: site.users.get(grant.principal_id) } }
      : { group: { id: grant.principal_id, displayName: grant.principal_name } };
  const body: Json = { id: uuidv5(key, NAMESPACE), roles: [grant.role], grantedToV2 };
  if (source !== null) body.inheritedFrom = { id: source.id, path: site.drivePath(source) };
  return body;
}

/** Starlette's rule, kept so text comes back decodable. */
function contentType(mimeType: string | null): string {
  const type = mimeType ?? "application/octet-stream";
  return type.startsWith("text/") && !type.toLowerCase().includes("charset=") ? `${type}; charset=utf-8` : type;
}

const DELTA_TOKEN = /^([0-9a-f]*-\d+)\.([01])\.(\d+)\.(-1|\d+)\.(\d+)\.([0-9a-f]*)$/;

/**
 * A delta position: changes in (start, end], or with `full` every item that existed at `end`, of
 * which `offset` were already sent. A deltaLink leaves `end` open (-1) until it's used.
 */
class Round {
  constructor(
    readonly full: boolean,
    readonly start: number,
    readonly end: number,
    readonly offset = 0,
  ) {}

  /** The last change the token has accounted for. */
  get position(): number {
    return this.end === -1 ? this.start : this.end;
  }

  /**
   * The token also carries the change log's digest at its position, so after a restart it's
   * refused unless the new log got there by the same changes.
   */
  link(c: Context, drive: Site, generation: string): string {
    const parts = [drive.name, generation, Number(this.full), this.start, this.end, this.offset];
    return link(c, { token: encodeToken(...parts, drive.history[this.position]!) });
  }
}

function round(c: Context, drive: Site, generation: string, token: string | undefined): Round {
  if (token === undefined) return new Round(true, 0, drive.seq);
  const decoded = decodeToken(token);
  const dot = decoded.indexOf(".");
  const site = dot < 0 ? decoded : decoded.slice(0, dot);
  const match = DELTA_TOKEN.exec(dot < 0 ? "" : decoded.slice(dot + 1));
  if (site !== drive.name || !match) throw badRequest("Invalid delta token.");
  const [, tokenGeneration, full, start, end, offset, history] = match;
  const at = new Round(full === "1", Number(start), Number(end), Number(offset));
  if (tokenGeneration !== generation || at.position > drive.seq || drive.history[at.position] !== history) {
    throw new GraphError(
      410,
      "resyncRequired",
      "Resync required: the token is no longer valid. Enumerate again from the Location.",
      { Location: link(c, { token: null }) },
      "resyncChangesApplyDifferences",
    );
  }
  return new Round(at.full, at.start, at.end === -1 ? drive.seq : at.end, at.offset);
}

function deltaEntry(drive: Site, item: Item, shared: boolean): Json {
  if (item.deletedSeq !== null) {
    return { id: item.id, deleted: { state: "deleted" }, parentReference: { id: item.parentId } };
  }
  const body = driveItem(drive, item, true);
  if (shared) body["@microsoft.graph.sharedChanged"] = "True";
  return body;
}

export function driveRoutes(app: Hono, rt: Runtime): void {
  /** The item a route names; `root` works as an id, and the `/drive/root` routes imply it. */
  const ref = (c: Context) => c.req.param("itemId") ?? "root";

  for (const base of ["/v1.0/sites/:site/drive/root", "/v1.0/sites/:site/drive/items/:itemId"]) {
    app.get(base, async (c) => {
      const drive = await siteAccess(c, rt);
      return c.json(driveItem(drive, drive.get(ref(c))));
    });

    /** Sorted by name (case-insensitive), then id, and paged by that key. */
    app.get(`${base}/children`, async (c) => {
      const drive = await siteAccess(c, rt);
      const size = top(c);
      const children = drive.children(drive.get(ref(c)));
      const { page, nextLink } = keysetPage(c, children, (child) => child.sortKey, size);
      const body: Json = { value: page.map((child) => driveItem(drive, child)) };
      if (nextLink) body["@odata.nextLink"] = nextLink;
      return c.json(body);
    });

    app.get(`${base}/content`, async (c) => {
      const drive = await siteAccess(c, rt);
      const item = drive.get(ref(c));
      if (item.folder) throw badRequest("A folder has no content.");
      const bytes = item.content ?? (await readFile(item.blob!));
      return c.body(new Uint8Array(bytes), 200, { "Content-Type": contentType(item.mimeType) });
    });

    /** Effective permissions, the root-most first; inherited ones carry `inheritedFrom`. */
    app.get(`${base}/permissions`, async (c) => {
      const drive = await siteAccess(c, rt);
      const item = drive.get(ref(c));
      return c.json({ value: drive.effective(item).map((effective) => permission(drive, item, effective)) });
    });
  }

  /**
   * Changes since `token`, or every item without one, one page at a time. Items appear once, in
   * their current state, in the order they first changed (or were created).
   */
  app.get("/v1.0/sites/:site/drive/root/delta", async (c) => {
    const drive = await siteAccess(c, rt);
    const token = query(c, "token");
    const size = top(c);
    const generation = rt.workspace.generation;
    if (token === "latest") {
      return c.json({ value: [], "@odata.deltaLink": new Round(false, drive.seq, -1).link(c, drive, generation) });
    }
    const at = round(c, drive, generation, token);
    const prefer = (c.req.header("prefer") ?? "").toLowerCase().split(",");
    const sharing = prefer.some((p) => p.trim() === "deltashowsharingchanges");
    const entries: [Item, boolean][] = at.full
      ? drive.existing(at.end).map((item) => [item, false])
      : drive.changed(at.start, at.end, sharing);
    const page = entries.slice(at.offset, at.offset + size);
    const body: Json = { value: page.map(([item, shared]) => deltaEntry(drive, item, shared && sharing)) };
    if (at.offset + size < entries.length) {
      body["@odata.nextLink"] = new Round(at.full, at.start, at.end, at.offset + size).link(c, drive, generation);
    } else {
      body["@odata.deltaLink"] = new Round(false, at.end, -1).link(c, drive, generation);
    }
    return c.json(body);
  });
}
