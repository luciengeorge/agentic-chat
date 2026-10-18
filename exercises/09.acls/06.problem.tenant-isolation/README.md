---
title: Tenant isolation
type: graded
slots:
  acl/tenant: tenant.ts
---

# Tenant isolation

👨‍💼 Kestrel Pay and Harbour Health are two customers of the same app. Their documents sit in the same `documents` table, their chunks in the same index, and their requests take turns on the same ten database connections. Nina Osei at Harbour asks "What is the hotel limit for a night in London?" Kestrel's policy says £200; Harbour's says £150. She must get Harbour's, and nothing of Kestrel's may ever reach her, not even the fact that a Heron memo exists.

## Terms

- A **tenant** is one customer: a better-auth organization. Every tenant table has a `tenant_id`.
- **RLS** (row-level security) is a Postgres feature: a **policy** on a table adds a condition to every query on it. Ours is "`tenant_id` equals the transaction's `app.tenant_id` setting".
- `SET LOCAL` sets a setting until the transaction ends. A plain `SET` keeps it for the rest of the connection's life.
- A **connection pool** keeps a few connections open and lends them to one request after another.
- `ac_app` is the role the app connects as. It owns no table and has no `BYPASSRLS`, so the policies bind it.

## Do this

🐨 Write `withTenantOn` in `playground/tenant.ts`. Every query the app makes for a user goes through it (`withTenant` in `@/db/tenant` passes the app's pool), as does every test in this section.

## A worked example

The same three counts, as `ac_app`:

| Where the query runs    | documents | chunks  | principals |
| ----------------------- | --------- | ------- | ---------- |
| inside Kestrel's tenant | 40        | 375     | 42         |
| inside Harbour's tenant | 6         | 59      | 10         |
| outside any tenant      | 0         | refused | 0          |
| as the owner (no RLS)   | 46        | 434     | 52         |

(The test corpus leaves out the FCA filing's 5,274 chunks.) "Refused" is pg_search: outside a tenant its index won't run at all ("pushdown expression should not evaluate to NULL"). Nina's search finds chunks of Harbour's 6 documents only. From Harbour's transaction, the Heron memo's id finds no row, and Daniel Reyes doesn't exist.

Run the tests with `pnpm ex test 09.6`. They need Postgres (`pnpm ex up`).
