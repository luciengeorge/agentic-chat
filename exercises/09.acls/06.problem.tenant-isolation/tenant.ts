// 👨‍💼 Harbour Health and Kestrel Pay share one database, one set of tables, one pool of connections. Nina Osei
//    at Harbour asks about the hotel limit, and the answer must come from Harbour's policy (£150 a night), never
//    Kestrel's (£200). Every query the app makes runs inside one function that says whose rows it may see.

/**
 * Tenant isolation (section 09.6). Every tenant table has a row-level security policy that compares its
 * `tenant_id` with the transaction's `app.tenant_id` setting, and the app connects as `ac_app`, a role that owns no
 * table and can't bypass RLS. So a query sees a tenant's rows only inside a transaction that set the tenant, and
 * nothing at all outside one.
 */
import type { Db } from "@/db/create";
import type { Tx } from "@/db/tenant";

/**
 * Runs `fn` in a transaction scoped to one tenant: `SET LOCAL app.tenant_id`, which the RLS policies read. On the
 * app role a query outside this sees no tenant rows, and a write into another tenant is refused.
 */
export async function withTenantOn<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // 🐨 Throw unless `tenantId` is a uuid, before anything touches the database.
  // 🐨 Open a transaction on `db`. Inside it, first set `app.tenant_id` to the tenant for this transaction only,
  //    then run `fn` with the transaction and return what it returns.
  //
  // 💰 Add `import { sql } from "drizzle-orm"`. A uuid matches
  //    `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`. `db.transaction(async (tx) => ...)`
  //    commits when the callback returns and rolls back when it throws. `SET` and `SET LOCAL` can't take a bound
  //    parameter, so set it with `SELECT set_config('app.tenant_id', ${tenantId}, ...)`. Its docs (below) say
  //    what the third argument decides.
  //
  // 🦉 How RLS uses it. Each tenant table has one policy, for every command: `tenant_id =
  //    NULLIF(current_setting('app.tenant_id', true), '')::uuid`. Postgres adds it to every query on the table,
  //    whatever the query says, and checks it on the rows a write would leave too. With no setting the right side
  //    is NULL, nothing equals NULL, and the query sees no rows: a forgotten `withTenant` fails closed.
  // 🦉 Why LOCAL, and why it's the classic mistake. The app shares ten connections between every request. A
  //    plain `SET` stays on the connection after the transaction ends, so the next request to borrow it, from any
  //    tenant, starts with Kestrel's tenant already set, and a missing `withTenant` there would see Kestrel's
  //    rows. `SET LOCAL` ends with the transaction, commit or rollback.
  // 🦉 Why the role matters as much. A table's owner skips its RLS policies unless the table is FORCEd, and a
  //    superuser or a BYPASSRLS role always does. Run the app as the owner (the other classic mistake, because
  //    it's what `DATABASE_URL` is when you start) and every policy is a no-op. So the app connects as `ac_app`,
  //    which owns nothing; migrations FORCE RLS on every tenant table anyway; and the jobs that must cross
  //    tenants (the relay, `pnpm sync`) use the owner's pool, `systemDb()`, by name.
  // 🦉 Where the tenant comes from. Always from the session's membership (`getViewer`, section 11), never from
  //    the request: a tenant id the client sends is a tenant id the client chose.
  // 🦉 Why check the uuid. It's bound as a parameter, so it can't inject SQL. The check is for the caller: an
  //    empty string or a slug would fail later as "no rows", which looks like an empty tenant, not a bug.
  //
  // 📜 https://www.postgresql.org/docs/current/ddl-rowsecurity.html
  // 📜 `set_config` (in "Configuration Settings Functions"):
  //    https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADMIN-SET
  //
  // 🚨 The tests check each tenant's counts inside and none outside, that fn gets the transaction that set the
  //    tenant, that the tenant is gone from a pooled connection after the transaction, a rollback when fn throws,
  //    a write into another tenant refused, a bad id refused before any transaction, the roles, and Nina's
  //    search finding only Harbour's documents.
  throw new Error(`withTenantOn(${typeof db}, ${JSON.stringify(tenantId)}, ${typeof fn}) isn't written yet`);
}
