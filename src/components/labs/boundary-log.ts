/**
 * The boundary lab's request log (section 11): the last requests through `viewerMiddleware`, kept in the dev server's
 * memory. Dev only: anywhere else `recordRequest` keeps nothing, so no process holds a log of who asked what.
 */
import { sql } from "drizzle-orm";

import type { Bucket } from "#learn/boundary/rate-limit";
import type { Viewer } from "@/lib/auth-server";

import { CHAT_BUCKET } from "#learn/boundary/rate-limit";
import { withTenant } from "@/db/tenant";
import { acEnv } from "@/lib/env";

/** The lab's own bucket, the chat bucket's size, so the lab can drain one without asking the model anything. */
export const LAB_BUCKET: Bucket = { ...CHAT_BUCKET, name: "lab" };

const BUCKETS: Record<string, Bucket> = { [CHAT_BUCKET.name]: CHAT_BUCKET, [LAB_BUCKET.name]: LAB_BUCKET };

export const LOG_SIZE = 50;

export interface BucketLevel {
  name: string;
  /** Tokens a request would find now: what was stored, plus the refill since (just what's stored, for a bucket this
   * lab doesn't know the size of). */
  tokens: number;
  capacity: number | null;
}

export interface LoggedRequest {
  id: number;
  at: string;
  method: string;
  /** The path, or the server function's name and file. */
  route: string;
  kind: "route" | "server function";
  viewer: string | null;
  tenant: string | null;
  status: number;
  ms: number;
  buckets: BucketLevel[];
}

interface Log {
  next: number;
  entries: LoggedRequest[];
}

// On globalThis, so a module reload in dev keeps the log.
const log = ((globalThis as { __acBoundaryLog?: Log }).__acBoundaryLog ??= { next: 1, entries: [] });

/** A bucket row as a request would find it at `now`: refilled for the time since, up to the capacity. */
export function level(row: { bucket: string; tokens: number; refilled_at: string | Date }, now: Date): BucketLevel {
  const bucket = BUCKETS[row.bucket];
  if (!bucket) return { name: row.bucket, tokens: row.tokens, capacity: null };
  const seconds = Math.max(0, (now.getTime() - new Date(row.refilled_at).getTime()) / 1000);
  return {
    name: row.bucket,
    tokens: Math.min(bucket.capacity, row.tokens + seconds * bucket.refillPerSecond),
    capacity: bucket.capacity,
  };
}

async function bucketLevels(viewer: Viewer): Promise<BucketLevel[]> {
  const rows = await withTenant(viewer.tenant.id, (tx) =>
    tx.execute<{ bucket: string; tokens: number; refilled_at: string }>(sql`
      SELECT bucket, tokens, refilled_at FROM rate_limit_buckets WHERE user_id = ${viewer.userId} ORDER BY bucket`),
  );
  const now = new Date();
  return rows.map((row) => level(row, now));
}

export async function recordRequest(entry: {
  request: Request;
  pathname: string;
  serverFn?: { name: string; filename: string };
  viewer: Viewer | null;
  status: number;
  ms: number;
}): Promise<void> {
  if (acEnv() !== "dev") return;
  // The lab polls the log every 2 s; noting its own reads would fill the log with them.
  if (entry.serverFn?.name === "getRequestLog") return;
  const buckets = entry.viewer ? await bucketLevels(entry.viewer).catch(() => []) : [];
  log.entries.unshift({
    id: log.next++,
    at: new Date().toISOString(),
    method: entry.request.method,
    route: entry.serverFn ? `${entry.serverFn.name} (${entry.serverFn.filename})` : entry.pathname,
    kind: entry.serverFn ? "server function" : "route",
    viewer: entry.viewer?.username ?? null,
    tenant: entry.viewer?.tenant.slug ?? null,
    status: entry.status,
    ms: Math.round(entry.ms),
    buckets,
  });
  log.entries.length = Math.min(log.entries.length, LOG_SIZE);
}

/** Newest first. */
export function recentRequests(): LoggedRequest[] {
  return [...log.entries];
}

export function clearRequests(): void {
  log.entries.length = 0;
}
