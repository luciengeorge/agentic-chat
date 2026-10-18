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
  const { tenantId, version } = await directoryVersion(tx);
  if (tenantId === null) return load(tx, userId);
  const key = `${tenantId}:${userId}`;
  const hit = cache.get(key);
  if (hit && hit.version === version) return hit.principalIds;
  const principalIds = await load(tx, userId);
  cache.set(key, { version, principalIds });
  return principalIds;
}
