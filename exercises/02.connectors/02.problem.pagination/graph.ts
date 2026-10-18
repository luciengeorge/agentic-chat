// 👨‍💼 The first time Kestrel connects its SharePoint, drive sync has to find every file: all 40 of them, in
//    18 folders. Graph never hands over a whole folder at once; it answers a page at a time. A crawl that
//    reads only the first page of each listing looks fine on a small folder and silently loses files on a
//    big one.

/**
 * A client for a Microsoft Graph-style drive and directory (fake-workspace plays SharePoint and Entra ID). It
 * pages with `@odata.nextLink`, reads changes with delta, and lists permissions, content and the directory. It
 * holds no state: the caller keeps the delta link (in `sync_state`).
 * `graphConnector` (`#learn/connectors/graph-connector`) wraps it as a `Connector`, which is all drive sync sees.
 */
import { ConnectorError, ResyncRequiredError } from "#learn/connectors/types";

export { ResyncRequiredError };
// The Graph client as a `Connector` lives on its own (section 02, step 1), and is exported from here too.
export { grantedIds, graphConnector, toSourceFile } from "#learn/connectors/graph-connector";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface GraphClientOptions {
  /** e.g. http://localhost:8100 */
  baseUrl: string;
  /** The site the drive and directory belong to (a tenant's slug in fake-workspace). */
  site: string;
  token: string;
  fetch?: Fetch;
  /** `$top` for listings. */
  pageSize?: number;
}

/** A Graph error answer, or a request that never got one (`status` 0). A 410 on a delta link is a
 * `ResyncRequiredError` instead: enumerate everything again. */
export class GraphRequestError extends ConnectorError {
  override name = "GraphRequestError";
}

export interface DriveItem {
  id: string;
  name: string;
  eTag: string;
  cTag?: string;
  size: number;
  lastModifiedDateTime: string;
  root?: object;
  parentReference?: { id: string; path?: string };
  folder?: { childCount: number };
  file?: { mimeType: string; hashes: { sha256Hash: string } };
}

/** A delta entry: an item in its current state, or a tombstone. */
export type DeltaEntry =
  | (DriveItem & { deleted?: undefined; "@microsoft.graph.sharedChanged"?: string })
  | { id: string; deleted: { state: string }; parentReference?: { id: string | null } };

export interface Permission {
  id: string;
  roles: string[];
  grantedToV2: { user?: { id: string; displayName?: string }; group?: { id: string; displayName: string } };
  inheritedFrom?: { id: string; path: string };
}

export interface DirectoryUser {
  id: string;
  userPrincipalName: string;
  displayName: string;
  accountEnabled: boolean;
}

export interface DirectoryGroup {
  id: string;
  displayName: string;
}

export type DirectoryMember =
  | ({ "@odata.type": "#microsoft.graph.user" } & DirectoryUser)
  | ({ "@odata.type": "#microsoft.graph.group" } & DirectoryGroup);

export interface Subscription {
  id: string;
  expirationDateTime: string;
  clientState: string;
}

/** A file with the path the crawl found it at. Folders aren't documents, so the crawl yields files only. */
export interface CrawledFile {
  item: DriveItem;
  path: string;
}

/** The item's path from its parent's `parentReference.path` (`/drive/root:/Finance/FP%26A`) and its name. */
export function itemPath(item: DriveItem): string {
  if (item.root) return "/";
  const parent = item.parentReference?.path;
  if (parent === undefined) throw new Error(`item ${item.id} has no parent path`);
  const prefix = parent.slice(parent.indexOf(":") + 1);
  return `${decodeURIComponent(prefix)}/${item.name}`;
}

/** Graph's sha256 is upper-case hex; `document_blobs` keys on lower case. */
export function sha256Of(item: DriveItem): string | null {
  return item.file?.hashes.sha256Hash.toLowerCase() || null;
}

export function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

export function createGraphClient(options: GraphClientOptions) {
  const { site, token, pageSize = 100 } = options;
  const fetch = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/$/, "");
  const sitePath = `/v1.0/sites/${encodeURIComponent(site)}`;
  const url = (path: string) => (path.startsWith("http") ? path : `${base}${path}`);

  /** One request. A refusal throws at once, whatever it was: step 3 adds the retries. */
  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url(path), {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
      });
    } catch (error) {
      throw new GraphRequestError(0, "networkError", `${init.method ?? "GET"} ${path}: ${(error as Error).message}`);
    }
    if (response.ok) return response;
    throw await errorFrom(response, path, retryAfterMs(response));
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (await send(path, init)).json()) as T;
  }

  type Page<T> = { value: T[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };

  /** Each page of a listing in turn, following `@odata.nextLink` until a page has none. */
  async function* pages<T>(path: string, headers?: Record<string, string>): AsyncGenerator<Page<T>> {
    // 🐨 Request `path` and yield the page that comes back. If it has an `@odata.nextLink`, request that
    //    next and yield its page, and so on, until a page comes back without one. That last page has
    //    entries too: yield it before you stop.
    //
    // 💰 `await json<Page<T>>(link, { headers })` sends one request (an absolute link is fine: url()
    //    handles both). `page["@odata.nextLink"]` is a string or undefined.
    //
    // 🦉 Why a listing comes in pages. A folder can hold thousands of items, and Graph won't build one huge
    //    answer. It sends `$top` items (up to 200 in SharePoint) and a link to the rest. Stop after the first
    //    page and nothing fails: you just quietly miss everything after it.
    // 🦉 Why you follow the link and never build it. Graph's link carries a `$skiptoken`, a bookmark that
    //    says "after this item", not "skip 5". If you counted (`$skip=5`, `$skip=10`) and someone deleted a
    //    file you'd already listed, everything would shift up one and you'd skip a file nobody deleted.
    //    A bookmark can't shift. And the link is opaque: Graph may change what's in it any day.
    //
    // 📜 https://learn.microsoft.com/en-us/graph/paging
    //
    // 🚨 (with crawlPages, below) The tests check that a listing is read to its last page, one request per
    //    page and each link requested exactly as given.
    throw new Error(`pages(${path}${headers ? ", with headers" : ""}) isn't written yet`);
  }

  /** Every entry of a paged listing; and the `@odata.deltaLink` it ends on, if any. */
  async function all<T>(path: string, headers?: Record<string, string>) {
    const value: T[] = [];
    let deltaLink: string | undefined;
    for await (const page of pages<T>(path, headers)) {
      value.push(...page.value);
      deltaLink = page["@odata.deltaLink"];
    }
    return { value, deltaLink };
  }

  /** Keyset paging can hand back an entry twice across pages if the listing changes; keep the last. */
  function dedupe<T extends { id: string }>(entries: T[]): T[] {
    return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
  }

  const top = `$top=${pageSize}`;

  return {
    site,

    item: (id: string) => json<DriveItem>(`${sitePath}/drive/items/${encodeURIComponent(id)}`),

    async children(id: string): Promise<DriveItem[]> {
      return dedupe((await all<DriveItem>(`${sitePath}/drive/items/${encodeURIComponent(id)}/children?${top}`)).value);
    },

    /**
     * Every file under `folderId` (the root by default), walking folders breadth first. An item seen twice is
     * yielded once.
     */
    async *crawl(folderId = "root"): AsyncGenerator<CrawledFile> {
      const seen = new Set<string>();
      const queue = [folderId];
      while (queue.length) {
        for (const item of await this.children(queue.shift()!)) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          if (item.folder) queue.push(item.id);
          else yield { item, path: itemPath(item) };
        }
      }
    },

    /**
     * The files under `folderId` a listing page at a time, walking folders breadth first: what a crawl of a big
     * drive looks like, so a caller can commit or report progress per page. Each file comes once.
     */
    async *crawlPages(folderId = "root"): AsyncGenerator<CrawledFile[]> {
      // 🐨 Walk the tree breadth first: keep a queue of folder ids to list, starting with `folderId`. For each
      //    folder, read its children listing page by page (your `pages`). In each page, a folder goes on
      //    the queue and a file becomes `{ item, path: itemPath(item) }`. Yield each page's files as one list,
      //    unless it has none.
      // 🐨 Remember the ids you've seen, and skip an item you've already had.
      //
      // 💰 The children listing is `${sitePath}/drive/items/${encodeURIComponent(id)}/children?${top}`.
      //    `item.folder` is set on a folder. `queue.shift()` takes the oldest. `new Set<string>()`.
      //
      // 🦉 Why folder by folder. Listing the root gives you its folders, not their files. A drive is a tree,
      //    and a full crawl has to visit every branch: Kestrel's root holds 7 folders and no files at all.
      // 🦉 Why a page at a time. Drive sync writes each page as it comes, so a crawl of a big drive shows
      //    progress and holds one page in memory, not the whole drive.
      // 🦉 Why an item can come twice. A bookmark says "after this name". If a file is renamed during the
      //    crawl from a name you've passed to one you haven't, the listing hands it to you again. Seen ids
      //    keep it once.
      // 🦉 New in this file, already written: send (one request, no retries yet), json, all (every entry of
      //    a listing, through your pages), children, and everything the delta, permissions and directory
      //    calls need.
      //
      // 🚨 The tests check that every one of Kestrel's 40 files comes back once, from every folder, whatever
      //    the page size; that no page is empty; and the requests a crawl at $top=5 makes: 20.
      throw new Error(`crawlPages(${folderId}) isn't written yet`);
    },

    /** A delta link for "from now on". Taken before a crawl, it catches every change the crawl might miss. */
    async latestDeltaLink(): Promise<string> {
      const page = await json<{ "@odata.deltaLink": string }>(`${sitePath}/drive/root/delta?token=latest`);
      return page["@odata.deltaLink"];
    },

    /**
     * The changes since `deltaLink`, each item once in its latest state, sharing changes included, and the link
     * to read from next. Throws `ResyncRequiredError` when the link is no longer valid.
     */
    async delta(deltaLink: string): Promise<{ changes: DeltaEntry[]; deltaLink: string }> {
      const { value, deltaLink: next } = await all<DeltaEntry>(deltaLink, {
        Prefer: "deltashowremovedasdeleted, deltashowsharingchanges",
      });
      if (!next) throw new GraphRequestError(502, "noDeltaLink", "the delta round ended without a deltaLink");
      return { changes: dedupe(value), deltaLink: next };
    },

    async permissions(id: string): Promise<Permission[]> {
      return (await json<{ value: Permission[] }>(`${sitePath}/drive/items/${encodeURIComponent(id)}/permissions`))
        .value;
    },

    async content(id: string): Promise<{ bytes: Uint8Array; contentType: string | null }> {
      const response = await send(`${sitePath}/drive/items/${encodeURIComponent(id)}/content`);
      return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") };
    },

    users: async () => dedupe((await all<DirectoryUser>(`${sitePath}/users?${top}`)).value),
    groups: async () => dedupe((await all<DirectoryGroup>(`${sitePath}/groups?${top}`)).value),
    members: async (groupId: string) =>
      dedupe((await all<DirectoryMember>(`${sitePath}/groups/${encodeURIComponent(groupId)}/members?${top}`)).value),
    transitiveMembers: async (groupId: string) =>
      dedupe(
        (await all<DirectoryMember>(`${sitePath}/groups/${encodeURIComponent(groupId)}/transitiveMembers?${top}`))
          .value,
      ),

    /** Change notifications for the drive. The service checks `notificationUrl` with a handshake first. */
    subscribe: (request: { notificationUrl: string; clientState: string; expirationDateTime: Date }) =>
      json<Subscription>("/v1.0/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          changeType: "updated",
          notificationUrl: request.notificationUrl,
          resource: `sites/${site}/drive/root`,
          expirationDateTime: request.expirationDateTime.toISOString(),
          clientState: request.clientState,
        }),
      }),

    renew: (id: string, expirationDateTime: Date) =>
      json<Subscription>(`/v1.0/subscriptions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expirationDateTime: expirationDateTime.toISOString() }),
      }),
  };
}

export type GraphClient = ReturnType<typeof createGraphClient>;

async function errorFrom(response: Response, path: string, retryAfter: number | null): Promise<GraphRequestError> {
  let code = "unknown";
  let message = response.statusText;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    // Not Graph's error shape; the status says enough.
  }
  const text = `${response.status} ${code} on ${path}: ${message}`;
  if (response.status === 410) return new ResyncRequiredError(410, code, text, retryAfter);
  return new GraphRequestError(response.status, code, text, retryAfter);
}
