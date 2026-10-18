// 👨‍💼 Every search Leo Martin makes starts with the same question: which principals is he? Himself, AP, Finance
//    and Kestrel, read from the closure. That answer changes when the directory changes, which is rarely; it's
//    asked on every request. So keep it. The hard part is knowing when it's out of date.

/**
 * The principal cache (section 09.2). Every search needs the viewer's principal set: themselves plus every group
 * in their closure. That set changes only when directory sync changes a membership, so it's cached per (tenant,
 * user) and keyed by the tenant's directory version, a counter directory sync bumps in the same transaction as the
 * membership change. Each request reads the version (one row) and reuses the cached set only when it matches, so
 * the request after a sync sees the new memberships.
 *
 * The set only feeds the recall pre-filter. If it were ever stale (a process that missed the bump, a membership
 * written by hand), search would look in too many documents or too few, but `readable()` decides every chunk in
 * Postgres against the live closure, so a stale set can never let a document through.
 */
import { sql } from "drizzle-orm";

import type { Tx } from "@/db/tenant";

export interface CachedPrincipals {
  /** The directory version the set was read at. */
  version: number;
  principalIds: string[];
}

export interface PrincipalCache {
  get(key: string): CachedPrincipals | undefined;
  set(key: string, entry: CachedPrincipals): void;
}

/** An in-process map that forgets its oldest entry once it holds `maxEntries`. */
export function createPrincipalCache(maxEntries = 10_000): PrincipalCache {
  const entries = new Map<string, CachedPrincipals>();
  return {
    get: (key) => entries.get(key),
    set(key, entry) {
      entries.delete(key);
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
      entries.set(key, entry);
    },
  };
}

/** The cache retrieval uses. Each process has its own; the version in Postgres keeps them all honest. */
export const sharedPrincipalCache = createPrincipalCache();

/** The tenant this transaction is scoped to (`withTenant`), and its directory version (0 before any change). */
export async function directoryVersion(tx: Tx): Promise<{ tenantId: string | null; version: number }> {
  const [row] = await tx.execute<{ tenant_id: string | null; version: string }>(sql`
    SELECT NULLIF(current_setting('app.tenant_id', true), '') AS tenant_id,
      coalesce((SELECT version FROM directory_versions), 0) AS version`);
  return { tenantId: row.tenant_id, version: Number(row.version) };
}

/** Moves the tenant's directory version on, in the caller's transaction: every cached set of the tenant is now
 * stale. Returns the new version. */
export async function bumpDirectoryVersion(tx: Tx, tenantId: string): Promise<number> {
  const [row] = await tx.execute<{ version: string }>(sql`
    INSERT INTO directory_versions (tenant_id, version) VALUES (${tenantId}, 1)
    ON CONFLICT (tenant_id) DO UPDATE SET version = directory_versions.version + 1, updated_at = now()
    RETURNING version`);
  return Number(row.version);
}

/**
 * The user's principal ids from the cache when it holds them at the current directory version, else from `load`,
 * stored for next time. The version is read before `load` runs, so a sync that commits in between leaves an entry
 * that's newer than its key, never older: the next request just loads again.
 */
export async function cachedPrincipals(
  tx: Tx,
  userId: string,
  cache: PrincipalCache,
  load: (tx: Tx, userId: string) => Promise<string[]>,
): Promise<string[]> {
  // 🐨 Read the tenant and its directory version (`directoryVersion`) first, before anything else.
  // 🐨 No tenant (outside `withTenant`): just load, and cache nothing.
  // 🐨 Otherwise the key is the tenant and the user together. If the cache holds an entry for it at this version,
  //    return its set. If not, load the set, store it with the version you read at the start, and return it.
  //
  // 💰 `const { tenantId, version } = await directoryVersion(tx)`. `cache.get(key)` gives `{ version,
  //    principalIds }` or undefined; `cache.set(key, entry)`. A template string makes the key.
  //
  // 🦉 What's cached, and what never is. The set of principals, never the answer to "may Leo read this?". The
  //    set only feeds the pre-filter (step 4), which narrows where search looks. The decision, `readable()`
  //    (step 3), runs in Postgres on every chunk, against the live closure. So if the set is ever stale, search
  //    looks in too many documents or too few, and still can't return one Leo may not read. Cache the decision
  //    instead (the classic mistake: "leo may read the invoices", kept for an hour), and a stale entry hands out
  //    a document he lost the right to.
  // 🦉 Why a version and not a timer. A timer (say, 5 minutes) serves the old set for up to 5 minutes after Leo
  //    leaves AP. Directory sync bumps the tenant's `directory_versions` row in the same transaction as the
  //    membership change, so the very next request sees a new number and loads again. One row read per request
  //    replaces a closure query.
  // 🦉 Why read the version first. If a sync commits while you load, you hold the old set. Stored under the old
  //    version, the next request misses and loads the new one. Stored under a version read after the load, the
  //    old set is filed under the new number, and stays until the next sync, which may be days away.
  // 🦉 Why the tenant in the key. The cache lives in the process and serves every tenant. Each tenant counts its
  //    own versions, so two tenants are often at the same number.
  //
  // 📜 https://martinfowler.com/bliki/TwoHardThings.html
  //
  // 🚨 The tests check one load for two requests, a reload after a sync that changes a membership (leo's 18
  //    candidate documents drop to 0), no reload after a sync that changes nothing, the version read before the
  //    load, tenants kept apart at the same version, nothing cached outside withTenant, and that a stale set
  //    over-fetches while readable() still refuses.
  throw new Error(`cachedPrincipals(${typeof tx}, ${userId}, ${typeof cache}, ${typeof load}) isn't written yet`);
}
