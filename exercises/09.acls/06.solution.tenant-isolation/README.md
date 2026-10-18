---
title: Tenant isolation
type: graded
slots:
  acl/tenant: tenant.ts
---

# Tenant isolation: the solution

`withTenantOn` throws `not a tenant id` unless the id is a uuid. Then it opens `db.transaction`, runs `SELECT set_config('app.tenant_id', $1, true)` on it, and returns `fn(tx)`.

## Why it works

- **The setting lives as long as the transaction.** `set_config(..., true)` is `SET LOCAL`: commit or roll back, and the connection goes back to the pool with no tenant. The next request that borrows it sees nothing until it sets its own.
- **Every query is filtered, whatever it says.** The policy is added by Postgres to every statement on a tenant table, so a query that forgets `WHERE tenant_id = ...`, or a join that wanders, still sees one tenant. A write is checked against the same condition, so a row can't be put in, or moved into, another tenant.
- **Forgetting fails closed.** Outside `withTenantOn` the setting is empty, the policy compares with NULL, and the answer is no rows. BM25 search even refuses outright (pg_search won't run with a NULL in its pushed-down filter).
- **The role makes the policy count.** `ac_app` owns no table and can't bypass RLS. The owner role (a superuser in dev) sees all 46 documents; that's why only migrations, the relay and cross-tenant scripts use it, through `systemDb()`, by name.
- **A failure keeps nothing.** `fn` runs inside the transaction, so a throw rolls back its writes, and the error comes out to the caller.

## The worked example

As `ac_app`: 40 documents, 375 chunks and 42 principals inside Kestrel; 6, 59 and 10 inside Harbour; nothing outside either. On a pool of one connection, a query straight after a Kestrel transaction sees 0 documents: with a plain `SET` it would have seen Kestrel's 40. Nina's question is answered from Harbour's travel policy. From Harbour's transaction, the Heron memo isn't there, `canRead` says no for Daniel (he isn't a principal of Harbour), and searching as Leo Martin in Harbour fails with `UnknownViewerError`.

Section 09 now has two walls. `readable()` decides who in a tenant may read what. RLS decides which tenant's rows a query can touch at all. A bug in one is still caught by the other: a `readable()` that let everyone through would still never cross tenants.
