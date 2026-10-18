/**
 * Tenant isolation (section 09.6). Every tenant table has a row-level security policy that compares its
 * `tenant_id` with the transaction's `app.tenant_id` setting, and the app connects as `ac_app`, a role that owns no
 * table and can't bypass RLS. So a query sees a tenant's rows only inside a transaction that set the tenant, and
 * nothing at all outside one.
 */
import { sql } from "drizzle-orm";

import type { Db } from "@/db/create";
import type { Tx } from "@/db/tenant";

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
