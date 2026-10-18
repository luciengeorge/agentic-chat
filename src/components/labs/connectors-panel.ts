import type { Fetch } from "#learn/connectors/graph";

import { createGraphClient } from "#learn/connectors/graph";
import { graphConnector } from "#learn/connectors/graph-connector";
import { ConnectorError } from "#learn/connectors/types";

import { CONTROL_HEADER, DEV_CONTROL_TOKEN } from "../../../servers/fake-workspace/control";

/** Where fake-workspace is and how to reach its control API, for one tenant's site. */
export interface Workspace {
  baseUrl: string;
  site: string;
  /** The site's bearer token, for Graph requests. */
  token: string;
  controlToken?: string;
  fetch?: Fetch;
}

export interface FaultSpec {
  kind: "throttle" | "error" | "latency";
  after_requests?: number;
  count?: number | null;
  retry_after_s?: number | null;
  status?: number;
  latency_ms?: number | null;
  path_prefix?: string | null;
}

export interface Delivery {
  id: string;
  subscription_id: string;
  change_seq: number;
  state: string;
  attempts: Array<{ at: string; status: number | null; error: string | null }>;
}

async function control<T>(ws: Workspace, method: string, path: string, json?: unknown): Promise<T | null> {
  const fetch = ws.fetch ?? globalThis.fetch;
  const response = await fetch(`${ws.baseUrl.replace(/\/$/, "")}/_control${path}`, {
    method,
    headers: { [CONTROL_HEADER]: ws.controlToken ?? DEV_CONTROL_TOKEN, "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
    } catch {
      // Not Graph's error shape: the text says it.
    }
    throw new Error(`fake-workspace answered ${response.status} to ${method} /_control${path}: ${message}`);
  }
  return text ? (JSON.parse(text) as T) : null;
}

export const addFault = (ws: Workspace, spec: FaultSpec) => control<FaultSpec>(ws, "POST", "/faults", spec);
export const clearFaults = (ws: Workspace) => control(ws, "DELETE", "/faults");
/** Pins fake-workspace's clock to `now`, or unpins it with null. */
export const setClock = async (ws: Workspace, now: string | null) =>
  (await control<{ now: string; pinned: boolean }>(ws, "POST", "/clock", { now }))!;
export const deliveries = async (ws: Workspace) =>
  (await control<{ value: Delivery[] }>(ws, "GET", "/deliveries"))!.value;
/** Waits for every pending delivery, retries included. */
export const flushDeliveries = async (ws: Workspace) =>
  (await control<{ value: Delivery[] }>(ws, "POST", "/flush"))!.value;
export const renameItem = (ws: Workspace, itemId: string, name: string) =>
  control(ws, "POST", `/sites/${encodeURIComponent(ws.site)}/items/${encodeURIComponent(itemId)}/rename`, { name });

export interface CrawlRequest {
  n: number;
  method: string;
  /** The path and query, without the host. */
  path: string;
  status: number | null;
  retryAfter: string | null;
  ms: number;
}

export interface CrawlResult {
  requests: CrawlRequest[];
  /** The waits the client asked for between retries, in ms. */
  waits: number[];
  pages: number;
  files: Array<{ id: string; path: string }>;
  error: { message: string; status: number | null; retryable: boolean; retryAfterMs: number | null } | null;
  ms: number;
}

/** No single wait in the lab lasts longer than this, so a long Retry-After doesn't hang the page. */
export const MAX_LAB_WAIT_MS = 5000;

/**
 * A full crawl of the site through `#learn/connectors/graph` and `#learn/connectors/graph-connector`: the learner's
 * client while a connectors step slots it, the reference otherwise. Every request and every wait is logged.
 */
export async function crawl(ws: Workspace, { pageSize, maxRetries }: { pageSize: number; maxRetries: number }) {
  const fetch = ws.fetch ?? globalThis.fetch;
  const started = Date.now();
  const out: CrawlResult = { requests: [], waits: [], pages: 0, files: [], error: null, ms: 0 };
  const graph = createGraphClient({
    baseUrl: ws.baseUrl,
    site: ws.site,
    token: ws.token,
    pageSize,
    maxRetries,
    sleep: async (ms) => {
      out.waits.push(ms);
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, MAX_LAB_WAIT_MS)));
    },
    fetch: async (url, init) => {
      const at = Date.now();
      const entry: CrawlRequest = {
        n: out.requests.length + 1,
        method: init?.method ?? "GET",
        path: url.replace(/^https?:\/\/[^/]+/, ""),
        status: null,
        retryAfter: null,
        ms: 0,
      };
      out.requests.push(entry);
      if (out.requests.length > 1000) throw new Error("the lab stops a crawl at 1,000 requests");
      const response = await fetch(url, init);
      entry.status = response.status;
      entry.retryAfter = response.headers.get("retry-after");
      entry.ms = Date.now() - at;
      return response;
    },
  });
  try {
    for await (const page of graphConnector(graph).crawl()) {
      out.pages += 1;
      out.files.push(...page.map((file) => ({ id: file.id, path: file.path })));
    }
  } catch (error) {
    out.error =
      error instanceof ConnectorError
        ? { message: error.message, status: error.status, retryable: error.retryable, retryAfterMs: error.retryAfterMs }
        : { message: (error as Error).message ?? String(error), status: null, retryable: false, retryAfterMs: null };
  }
  out.files.sort((a, b) => a.path.localeCompare(b.path));
  out.ms = Date.now() - started;
  return out;
}
