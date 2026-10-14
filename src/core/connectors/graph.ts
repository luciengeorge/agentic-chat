/**
 * A client for a Microsoft Graph-style drive and directory (fake-workspace plays SharePoint and Entra ID). It
 * pages with `@odata.nextLink`, backs off on 429 as `Retry-After` says, reads changes with delta, and lists
 * permissions, content and the directory. It holds no state: the caller keeps the delta link (in `sync_state`).
 * `graphConnector` wraps it as a `Connector` (`#learn/connectors/types`), which is all drive sync sees.
 */
import {
  type Change,
  type Connector,
  ConnectorError,
  ResyncRequiredError,
  type SourceFile,
} from "#learn/connectors/types";

export { ResyncRequiredError };

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface GraphClientOptions {
  /** e.g. http://localhost:8100 */
  baseUrl: string;
  /** The site the drive and directory belong to (a tenant's slug in fake-workspace). */
  site: string;
  token: string;
  fetch?: Fetch;
  /** Waits between retries; tests pass one that records and returns at once. */
  sleep?: (ms: number) => Promise<void>;
  /** Retries of a throttled (429) or unavailable (503) request before it fails. */
  maxRetries?: number;
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

const RETRY_STATUSES = new Set([429, 503]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  const { site, token, maxRetries = 5, pageSize = 100 } = options;
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const base = options.baseUrl.replace(/\/$/, "");
  const sitePath = `/v1.0/sites/${encodeURIComponent(site)}`;
  const url = (path: string) => (path.startsWith("http") ? path : `${base}${path}`);

  /** One request, retried on 429 and 503 after `Retry-After` (or an exponential wait without one). */
  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
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
      const wait = retryAfterMs(response);
      if (RETRY_STATUSES.has(response.status) && attempt < maxRetries) {
        await response.body?.cancel();
        await sleep(wait ?? Math.min(500 * 2 ** attempt, 30_000));
        continue;
      }
      throw await errorFrom(response, path, wait);
    }
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (await send(path, init)).json()) as T;
  }

  type Page<T> = { value: T[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };

  /** Each page of a listing in turn, following `@odata.nextLink` until a page has none. */
  async function* pages<T>(path: string, headers?: Record<string, string>): AsyncGenerator<Page<T>> {
    let next: string | undefined = path;
    while (next) {
      const page: Page<T> = await json(next, { headers });
      yield page;
      next = page["@odata.nextLink"];
    }
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
      const seen = new Set<string>();
      const queue = [folderId];
      while (queue.length) {
        const folder = queue.shift()!;
        for await (const page of pages<DriveItem>(
          `${sitePath}/drive/items/${encodeURIComponent(folder)}/children?${top}`,
        )) {
          const files: CrawledFile[] = [];
          for (const item of page.value) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            if (item.folder) queue.push(item.id);
            else files.push({ item, path: itemPath(item) });
          }
          if (files.length) yield files;
        }
      }
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
 * The Graph client as a `Connector`. Graph's delta lists a changed item without its path, and a renamed or moved
 * folder without its contents, so a changed file is read again for its path and a changed folder's files are
 * crawled again (which re-paths what a folder rename moved). A file deleted between the delta and the read is
 * skipped: the next delta brings its tombstone.
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
      for (const change of changes) {
        if (change.deleted) {
          out.push({ type: "deleted", id: change.id });
        } else if ("root" in change && change.root) {
          continue;
        } else if ("folder" in change && change.folder) {
          for await (const page of graph.crawlPages(change.id)) {
            for (const { item, path } of page) out.push({ type: "file", file: toSourceFile(item, path) });
          }
        } else {
          let item: DriveItem;
          try {
            item = await graph.item(change.id);
          } catch (error) {
            if (error instanceof GraphRequestError && error.status === 404) continue;
            throw error;
          }
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
