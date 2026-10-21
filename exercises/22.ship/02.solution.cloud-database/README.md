---
title: ParadeDB in the cloud, secrets and migrations
type: guided
---

# ParadeDB in the cloud, secrets and migrations: what you saw

This was rehearsed on 21 October 2026 against a scratch database on the local ParadeDB, with the production build on :3021 standing in for Vercel. The numbers below are from that run; yours differ only in host names and times.

## The migration

```
target ac@kestrel-paradedb-<you>.fly.dev:5432/ac, Postgres 18.6 (Debian 18.6-1.pgdg13+2); 0 migrations already applied
applied 13 (13 in all); pg_search 0.26.1, vector 0.8.6
ac_app signs in, doesn't bypass row-level security, and sees 0 documents without a tenant
```

Before it changes anything, `db:migrate:remote` refuses:

- a `DATABASE_URL` that isn't `ac_app`, or whose password is under 16 characters (the dev one is 6);
- two URLs that point at different databases;
- a server without `pg_search` or `vector` ("run the paradedb/paradedb image (Fly, Railway) or ParadeDB Cloud");
- an owner bound by RLS. The relay and the cron routes read every tenant's outbox through the owner's pool; an owner without `BYPASSRLS` would see no rows, and the relay would quietly deliver nothing.

Then drizzle applies the pending migrations in one transaction, `enableAppLogin` gives `ac_app` its password, and the script signs in as `ac_app` to read `documents` with no tenant set: 0 rows. Run it twice and the second says `applied 0`.

**The extension notes.** The ParadeDB image ships both extensions, and the first migration runs `CREATE EXTENSION IF NOT EXISTS` for each. `pg_search` needs a superuser to create, which the image's `POSTGRES_USER` is; on a managed service, its console may have to enable it. Since 0.25, `pg_search` needs `vector` installed first. A new database gets `vector` 0.8.6, while your dev database, made earlier, still says 0.8.4: an image's newer extension only reaches an existing database through `ALTER EXTENSION vector UPDATE` (the gotcha `HANDOFF.md` notes for `pg_search`).

## The copy

The content tables came to a 53 MB dump (4.7 s) and restored in 10 s locally: 2 tenants, 37 people, 47 documents, 5,708 chunks with their 1,536-dimension embeddings, the closure, the ACLs, and `acl_version_seq` at 54. Over the network to London it's the upload of 53 MB. The BM25 and HNSW indexes already existed from the migrations, so every row was indexed as it arrived.

Two choices in that command. `--data-only` leaves the schema to the migrations, so the cloud database's schema came from the same files CI checks, and `drizzle.__drizzle_migrations` stays true. And `--table`, one per content table, leaves the operational rows behind: sessions, runs and their events, the outbox, the rate-limit buckets and the audit. Copied, a session would sign someone in on the cloud with a cookie made on your laptop, and an unpublished outbox row would start a sync against a workspace that doesn't exist.

## The passwords

`db:rotate-passwords` printed `37 accounts have the new password; 0 sessions ended`. It hashes the new password with better-auth's own `hashPassword` (scrypt), so better-auth's sign-in checks it as one of its own, and the old one now gets `401 INVALID_EMAIL_OR_PASSWORD`. It refuses the dev database, whose people keep `dev-password`. peter.hall's password changed too, and he's still refused: a ban is its own column.

## TLS and the URLs

`sslmode=verify-full` makes postgres.js check that the certificate is Fly's for `<app>.fly.dev`, so a machine in the middle can't pose as the database. `require` encrypts and checks nothing. `psql` and `pg_restore` get `require` in these commands only because libpq's `verify-full` also wants a root certificate path.

## Connections, a limit to know

Each warm Vercel function instance opens its own pools: one for `ac_app` and one for the owner, up to 10 connections each (postgres.js's default). The ParadeDB image allows 100 connections. Five busy instances could take them all. At Kestrel's size that's fine; the production answer is a pooler such as PgBouncer in front of Postgres, which hands a few real connections to many short-lived clients.

## What it costs

On Fly: $6.70 (the Machine) + $1.50 (10 GB) + $2 (the IPv4) = $10.20 a month at Fly's Ashburn rates, London a little more. Fly snapshots the volume daily and keeps 5 days by default; the first 10 GB of snapshots a month are free. To pause the spending, `fly scale count 0 --app "$FLY_APP"` stops the Machine (the volume still bills); `fly apps destroy "$FLY_APP"` ends it all, data included.

## In an interview

"Postgres is the one stateful piece, with BM25 and vectors in the same database as the ACLs, so the hosting choice is wherever I can run the ParadeDB image with a disk: a Fly Machine with a volume, TLS terminated by Fly's Postgres-aware proxy. Migrations run as the owner from CI or a laptop; the app connects as a role that owns nothing and that RLS binds, and the migration script proves that before it finishes. Seeded credentials never ship: the copy gets new passwords before the app can reach it."
