/**
 * A client for a Microsoft Graph-style drive and directory (fake-workspace plays SharePoint and Entra ID). It
 * pages with `@odata.nextLink`, backs off on 429 as `Retry-After` says, reads changes with delta, and lists
 * permissions, content and the directory. It holds no state: the caller keeps the delta link (in `sync_state`).
 */

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

/** A Graph error answer, or a request that never got one (`status` 0). */
export class GraphRequestError extends Error {
  override name = "GraphRequestError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** From `Retry-After`, when the answer had one. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }

  /** Worth trying again later: throttling, an outage, or no answer at all. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/** The delta link is no longer valid (410): enumerate everything again. */
export class ResyncRequiredError extends GraphRequestError {
  override name = "ResyncRequiredError";
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

  /** Every entry of a paged listing, following `@odata.nextLink`; and the `@odata.deltaLink` it ends on, if any. */
  async function all<T>(path: string, headers?: Record<string, string>) {
    const value: T[] = [];
    let next: string | undefined = path;
    let deltaLink: string | undefined;
    while (next) {
      const page: { value: T[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string } = await json(next, {
        headers,
      });
      value.push(...page.value);
      next = page["@odata.nextLink"];
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
