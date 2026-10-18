/**
 * A client for a Microsoft Graph-style drive and directory (fake-workspace plays SharePoint and Entra ID). It
 * pages with `@odata.nextLink`, backs off on 429 as `Retry-After` says, reads changes with delta, and lists
 * permissions, content and the directory. It holds no state: the caller keeps the delta link (in `sync_state`).
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

export const RETRY_STATUSES = new Set([429, 503]);

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

/**
 * How long to wait before trying `response`'s request again, or null to give up: only a throttle (429) or an
 * outage (503) is worth another try, and only `maxRetries` times. The wait is what `Retry-After` says, or without
 * one 500 ms doubling each attempt, at most 30 s.
 */
export function retryDelay(response: Response, attempt: number, maxRetries: number): number | null {
  if (!RETRY_STATUSES.has(response.status) || attempt >= maxRetries) return null;
  return retryAfterMs(response) ?? Math.min(500 * 2 ** attempt, 30_000);
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
      const wait = retryDelay(response, attempt, maxRetries);
      if (wait !== null) {
        // Free the connection: an unread body holds it open.
        await response.body?.cancel();
        await sleep(wait);
        continue;
      }
      throw await errorFrom(response, path, retryAfterMs(response));
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
