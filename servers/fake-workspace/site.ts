/** One tenant's drive, in memory: its items, their sharing, and a change log. */
import { createHash } from "node:crypto";
import { v5 as uuidv5 } from "uuid";

import { iso } from "./clock";
import { GraphError, badRequest, notFound } from "./errors";

/** For the ids fake-workspace makes itself: new items, permissions, subscriptions, tenants. */
export const NAMESPACE = "8f1d3a52-6c7e-4b1a-9d2f-3e5c7a9b0d14";

const INVALID_NAME_CHARS = /["*:<>?/\\|]/;

export type Role = "read" | "write";

export interface Grant {
  readonly principal_type: "user" | "group";
  readonly principal_id: string;
  readonly principal_name: string;
  readonly role: Role;
}

export interface Sharing {
  readonly inherit: boolean;
  readonly grants: readonly Grant[];
}

export interface Effective {
  readonly grant: Grant;
  /** The ancestor it's inherited from; null when it's the item's own. */
  readonly source: Item | null;
}

interface Change {
  readonly itemId: string;
  /** Only the item's effective sharing changed. */
  readonly sharing: boolean;
}

export type SortKey = readonly [string, string];

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function nameKey(name: string): string {
  return name.toLowerCase();
}

/** Tuple order, as Python compares them. */
export function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

export class Item {
  createdSeq = 0;
  deletedSeq: number | null = null;
  /** eTag: any change to the item, its effective sharing included. */
  version = 1;
  /** cTag: content only. */
  contentVersion = 1;
  mimeType: string | null = null;
  size = 0;
  sha256: string | null = null;
  blob: string | null = null;
  /** Uploaded through the control API; otherwise the blob is served. */
  content: Uint8Array | null = null;

  constructor(
    readonly id: string,
    public name: string,
    public parentId: string | null,
    readonly folder: boolean,
    readonly created: Date,
    public modified: Date,
    /** A user id; null when the control API made the change. */
    readonly createdBy: string | null,
    public modifiedBy: string | null,
    public sharing: Sharing,
  ) {}

  get etag(): string {
    return `"{${this.id.toUpperCase()}},${this.version}"`;
  }

  get ctag(): string {
    return `"c:{${this.id.toUpperCase()}},${this.contentVersion}"`;
  }

  /** How children are listed: by name, case-insensitively, then by id. */
  get sortKey(): SortKey {
    return [nameKey(this.name), this.id];
  }

  store(content: Uint8Array, mimeType: string | null): void {
    this.content = content;
    this.size = content.length;
    this.sha256 = sha256(content);
    if (mimeType !== null) this.mimeType = mimeType;
  }
}

type Acl = Set<string>;

/** One tenant's drive. Deleted items stay as tombstones so delta can report them. */
export class Site {
  /** In creation order. */
  readonly items = new Map<string, Item>();
  /** Change n has seq n + 1. */
  readonly changes: Change[] = [];
  /** `history[n]`: a digest of the first n changes and what they left. */
  readonly history: string[] = [""];
  rootId = "";
  private created = 0;

  constructor(
    readonly name: string,
    /** User id to display name. */
    readonly users: ReadonlyMap<string, string>,
    /** Group id to path. */
    readonly groups: ReadonlyMap<string, string>,
  ) {}

  get seq(): number {
    return this.changes.length;
  }

  get(ref: string): Item {
    const item = this.items.get(ref === "root" ? this.rootId : ref);
    if (!item || item.deletedSeq !== null) throw notFound();
    return item;
  }

  children(item: Item): Item[] {
    const live = [...this.items.values()].filter((i) => i.parentId === item.id && i.deletedSeq === null);
    return live.sort((a, b) => compareKeys(a.sortKey, b.sortKey));
  }

  /** Depth first, each folder before its contents. */
  descendants(item: Item): Item[] {
    return this.children(item).flatMap((child) => [child, ...this.descendants(child)]);
  }

  path(item: Item): string {
    const names: string[] = [];
    for (let node = item; node.parentId !== null; node = this.items.get(node.parentId)!) {
      names.push(node.name);
    }
    return "/" + names.reverse().join("/");
  }

  /** Graph's percent-encoded API path, e.g. `/drive/root:/Finance/FP%26A`. */
  drivePath(item: Item): string {
    return "/drive/root:" + (item.parentId === null ? "" : quote(this.path(item)));
  }

  size(item: Item): number {
    if (!item.folder) return item.size;
    return this.descendants(item).reduce((sum, d) => sum + (d.folder ? 0 : d.size), 0);
  }

  /**
   * The grants that name no user or group of this site. A group grant's name must be that group's
   * path too, since permissions show it as the group's displayName.
   */
  strangers(grants: readonly Grant[]): Grant[] {
    return grants.filter((g) =>
      g.principal_type === "user"
        ? !this.users.has(g.principal_id)
        : this.groups.get(g.principal_id) !== g.principal_name,
    );
  }

  /**
   * Own grants plus, while `inherit` holds, the parent's effective ones. The stronger role wins when
   * a principal appears twice.
   */
  effective(item: Item): Effective[] {
    const chain = [item];
    for (let node = item; node.sharing.inherit && node.parentId !== null;) {
      node = this.items.get(node.parentId)!;
      chain.push(node);
    }
    const result = new Map<string, Effective>();
    for (const node of chain.reverse()) {
      for (const grant of node.sharing.grants) {
        const key = `${grant.principal_type}:${grant.principal_id}`;
        const held = result.get(key);
        if (!held || (grant.role === "write" && held.grant.role === "read")) {
          result.set(key, { grant, source: node === item ? null : node });
        }
      }
    }
    return [...result.values()];
  }

  /**
   * Items changed in (start, end], once each in order of first change, with whether their sharing
   * changed. Items whose only change is sharing count only when `sharing` is set.
   */
  changed(start: number, end: number, sharing: boolean): [Item, boolean][] {
    const flags = new Map<string, { other: boolean; shared: boolean }>();
    for (const change of this.changes.slice(start, end)) {
      const seen = flags.get(change.itemId) ?? { other: false, shared: false };
      flags.set(change.itemId, { other: seen.other || !change.sharing, shared: seen.shared || change.sharing });
    }
    return [...flags]
      .filter(([, { other, shared }]) => other || (shared && sharing))
      .map(([itemId, { shared }]) => [this.items.get(itemId)!, shared]);
  }

  /**
   * Every item that existed after change `end`, in creation order: parents first unless a folder
   * moved under a newer one. A tree walk always would be, but a move during the round would shift
   * its offsets and skip an item.
   */
  existing(end: number): Item[] {
    return [...this.items.values()].filter((i) => i.createdSeq <= end && (i.deletedSeq === null || i.deletedSeq > end));
  }

  // Mutations. Each records its changes; the caller sends the notifications.

  createFile(parentRef: string, name: string, content: Uint8Array, mimeType: string, now: Date): Item {
    const parent = this.folderItem(parentRef);
    this.checkName(parent, name);
    this.created += 1;
    const path = `${this.path(parent).replace(/\/$/, "")}/${name}`;
    const id = uuidv5(`${this.name}:${path}:${this.created}`, NAMESPACE);
    const item = new Item(id, name, parent.id, false, now, now, null, null, { inherit: true, grants: [] });
    item.createdSeq = this.seq + 1;
    item.store(content, mimeType);
    this.items.set(item.id, item);
    this.record(item);
    return item;
  }

  upload(ref: string, content: Uint8Array, mimeType: string | null, now: Date): Item {
    const item = this.get(ref);
    if (item.folder) throw badRequest("A folder has no content.");
    item.store(content, mimeType);
    item.contentVersion += 1;
    this.touch(item, now);
    return item;
  }

  rename(ref: string, name: string, now: Date): Item {
    const item = this.movable(ref);
    this.checkName(this.items.get(item.parentId!)!, name, item);
    item.name = name;
    this.touch(item, now);
    return item;
  }

  move(ref: string, parentRef: string, name: string | null, now: Date): Item {
    const item = this.movable(ref);
    const parent = this.folderItem(parentRef);
    if (parent === item || this.descendants(item).some((d) => d.id === parent.id)) {
      throw badRequest("A folder can't move into itself.");
    }
    const newName = name ?? item.name;
    this.checkName(parent, newName, item);
    const before = this.acls(item);
    item.parentId = parent.id;
    item.name = newName;
    this.touch(item, now);
    this.recordAclChanges(before);
    return item;
  }

  delete(ref: string): void {
    for (const doomed of this.bottomUp(this.movable(ref))) {
      doomed.deletedSeq = this.seq + 1;
      this.record(doomed);
    }
  }

  setSharing(ref: string, sharing: Sharing): Item {
    const item = this.get(ref);
    const strangers = this.strangers(sharing.grants);
    if (strangers.length) {
      const names = strangers.map((g) => `${g.principal_type} ${g.principal_name} (${g.principal_id})`).join(", ");
      throw badRequest(`Not a user or group of this site: ${names}.`);
    }
    const before = this.acls(item);
    before.delete(item.id);
    item.sharing = sharing;
    item.version += 1;
    this.record(item, true);
    this.recordAclChanges(before);
    return item;
  }

  private record(item: Item, sharing = false): void {
    this.changes.push({ itemId: item.id, sharing });
    const state = JSON.stringify([
      item.id,
      sharing,
      item.name,
      item.parentId,
      item.deletedSeq !== null,
      item.version,
      item.sha256,
      iso(item.modified),
      item.sharing,
    ]);
    this.history.push(sha256(this.history.at(-1)! + state).slice(0, 16));
  }

  private touch(item: Item, now: Date): void {
    item.version += 1;
    item.modified = now;
    item.modifiedBy = null;
    this.record(item);
  }

  /**
   * What the item's permissions show, so a grant that moves to another ancestor (its
   * `inheritedFrom`) counts as a sharing change too.
   */
  private acl(item: Item): Acl {
    return new Set(
      this.effective(item).map(({ grant, source }) =>
        JSON.stringify([grant.principal_type, grant.principal_id, grant.role, source?.id ?? null]),
      ),
    );
  }

  private acls(item: Item): Map<string, Acl> {
    return new Map([item, ...this.descendants(item)].map((i) => [i.id, this.acl(i)]));
  }

  /**
   * A sharing change for every item whose effective sharing changed, with a new eTag, so a
   * connector that skips unchanged eTags still sees a revoked grant.
   */
  private recordAclChanges(before: Map<string, Acl>): void {
    for (const [itemId, acl] of before) {
      const item = this.items.get(itemId)!;
      const after = this.acl(item);
      if (after.size !== acl.size || [...after].some((entry) => !acl.has(entry))) {
        item.version += 1;
        this.record(item, true);
      }
    }
  }

  private bottomUp(item: Item): Item[] {
    return [...this.children(item).flatMap((child) => this.bottomUp(child)), item];
  }

  private folderItem(ref: string): Item {
    const item = this.get(ref);
    if (!item.folder) throw badRequest("The parent must be a folder.");
    return item;
  }

  private movable(ref: string): Item {
    const item = this.get(ref);
    if (item.parentId === null) throw badRequest("The root can't be moved, renamed or deleted.");
    return item;
  }

  private checkName(parent: Item, name: string, moving?: Item): void {
    if (!name.trim() || INVALID_NAME_CHARS.test(name)) throw badRequest(`'${name}' isn't a valid name.`);
    if (this.children(parent).some((c) => c !== moving && nameKey(c.name) === nameKey(name))) {
      throw new GraphError(409, "nameAlreadyExists", `'${name}' already exists in this folder.`);
    }
  }
}

/** Percent-encodes a path as Python's `urllib.parse.quote` does: everything but `A-Za-z0-9_.-~/`. */
function quote(path: string): string {
  return path
    .split("/")
    .map((name) =>
      encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join("/");
}
