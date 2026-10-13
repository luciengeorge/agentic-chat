import { sql } from "drizzle-orm";

import type { Db } from "./create";

import { appDb } from "./pool";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in a transaction scoped to one tenant: `SET LOCAL app.tenant_id`, which the RLS policies read. On the
 * app role a query outside this sees no tenant rows, and a write into another tenant is refused.
 */
export async function withTenantOn<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error(`not a tenant id: ${JSON.stringify(tenantId)}`);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/** `withTenantOn` the app role's pool. */
export function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenantOn(appDb(), tenantId, fn);
}
