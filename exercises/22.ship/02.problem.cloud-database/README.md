---
title: ParadeDB in the cloud, secrets and migrations
type: guided
---

# ParadeDB in the cloud, secrets and migrations

👨‍💼 The preview from step 1 has nowhere to keep anything. Kestrel's search, ACLs and agent runs all live in one Postgres with two extensions, `pg_search` (BM25) and `vector`. Most hosted Postgres services offer `vector` and not `pg_search`, and Neon retired its `pg_search` in September 2026. So the database runs the image you already run locally, `paradedb/paradedb:0.26.1-pg18`, somewhere that keeps a disk.

## Terms

- A **Fly Machine** is a small virtual machine running one container image. A **volume** is a disk attached to it that outlives restarts and redeploys.
- **TLS** encrypts the connection. Fly's `pg_tls` handler speaks Postgres's own way of starting TLS at Fly's edge, so the database itself needs no certificate.
- The **owner** role created the tables and bypasses row-level security; **`ac_app`** is the role the app connects as, which RLS binds (section 09.6). Two URLs, two passwords.

## Where to run it (prices checked 21 October 2026)

|                     | Fly                                                                                               | Railway                                                                                                                                              | ParadeDB Cloud                                               |
| ------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| What runs           | the ParadeDB image on a Machine, with a volume                                                    | the ParadeDB image as a service, with a volume                                                                                                       | ParadeDB's managed service                                   |
| This app, a month   | 1 GB shared CPU $6.70 + 10 GB volume $1.50 + dedicated IPv4 $2 = **$10.20** (Fly's Ashburn rates) | Hobby plan $5, which includes $5 of usage; 1 GB of RAM all month is $10, 10 GB of volume $1.50, plus CPU at $20 per vCPU-month: **about $12 to $15** | **no published price**: "Available now", by sign-up or sales |
| CLI on this machine | `fly` v0.4.102                                                                                    | not installed                                                                                                                                        | none                                                         |

Fly: no free tier, a card on file, prices vary by region. Railway: a 30-day trial with $5 of credit. The one public number for managed ParadeDB is Ubicloud's, $0.193 an hour for 2 vCPUs, 8 GB and 128 GB (about $141 a month, October 2024). Sources: [Fly pricing](https://docs.fly.io/about/pricing), [Railway pricing](https://railway.com/pricing), [ParadeDB pricing](https://www.paradedb.com/pricing), [Ubicloud's managed ParadeDB](https://ubicloud.com/blog/elastic-quality-full-text-search-on-postgres).

**Use Fly**: the cheapest, its CLI is installed, and it runs the exact image CI and Docker run.

## Do this

1. 🐨 Make the passwords and the app (pick your own app name: it's global). Keep both passwords in your password manager.
   ```sh
   export FLY_APP=kestrel-paradedb-<you>
   export OWNER_PASSWORD=$(openssl rand -hex 24) APP_PASSWORD=$(openssl rand -hex 16)
   fly auth login
   fly apps create "$FLY_APP"
   fly volumes create pgdata --app "$FLY_APP" --region lhr --size 10 --yes
   fly secrets set --app "$FLY_APP" --stage POSTGRES_PASSWORD="$OWNER_PASSWORD"
   fly ips allocate-v4 --app "$FLY_APP" --yes
   ```
2. 🐨 Save this as `~/kestrel-cloud/fly.toml` (outside the repo), with your app name, and deploy it from that folder with `fly deploy --app "$FLY_APP"`.
   ```toml
   app = "kestrel-paradedb-<you>"
   primary_region = "lhr"
   
   [build]
   image = "paradedb/paradedb:0.26.1-pg18"
   
   [env]
   POSTGRES_USER = "ac"
   POSTGRES_DB = "ac"
   
   [[mounts]]
   source = "pgdata"
   destination = "/var/lib/postgresql"
   
   [[services]]
   internal_port = 5432
   protocol = "tcp"
   auto_stop_machines = "off"
   min_machines_running = 1
   [[services.ports]]
   port = 5432
   handlers = ["pg_tls"]
   
   [[vm]]
   size = "shared-cpu-1x"
   memory = "1gb"
   ```
   Then `psql "postgres://ac:$OWNER_PASSWORD@$FLY_APP.fly.dev:5432/ac?sslmode=require" -c "SELECT version()"` answers with PostgreSQL 18.
3. 🐨 Migrate, as the owner, from your machine. The script reads only your shell, never `.env.local`, checks the server before it changes anything, and checks `ac_app` after.
   ```sh
   export DATABASE_ADMIN_URL="postgres://ac:$OWNER_PASSWORD@$FLY_APP.fly.dev:5432/ac?sslmode=verify-full"
   export DATABASE_URL="postgres://ac_app:$APP_PASSWORD@$FLY_APP.fly.dev:5432/ac?sslmode=verify-full"
   pnpm db:migrate:remote
   ```
4. 🐨 Copy the content (tenants, people, groups, documents, chunks with their embeddings, ACLs) from your dev database. Operational rows (sessions, runs, the outbox, the audit) stay behind.
   ```sh
   tables=""; for t in organization user account member principals group_members group_closure directory_versions \
     documents document_blobs chunks document_acl ocr_reviews agent_switches acl_version_seq; do tables="$tables --table=public.\"$t\""; done
   docker compose exec -T paradedb sh -c "pg_dump -U ac -d ac --data-only --format=custom $tables" > ~/kestrel-cloud/data.dump
   pg_restore --data-only --no-owner --exit-on-error --dbname="${DATABASE_ADMIN_URL/verify-full/require}" ~/kestrel-cloud/data.dump
   ```
5. 🐨 The copied people sign in with world.yaml's password, which is public. Give them one only you know, before the app can reach this database.
   ```sh
   read -rs ACCOUNT_PASSWORD && export ACCOUNT_PASSWORD   # type it; it stays out of your shell history
   pnpm db:rotate-passwords
   ```
6. 🐨 Give Vercel its variables: for Production and Preview, `DATABASE_URL`, `DATABASE_ADMIN_URL`, `OPENAI_API_KEY`, `COHERE_API_KEY`, and a fresh `openssl rand -hex 32` each for `BETTER_AUTH_SECRET`, `TOAST_SECRET` and `CRON_SECRET`. Mark them **Sensitive**. `BETTER_AUTH_URL` and `VITE_SITE_URL` are per environment: Production gets the domain under **Settings**, **Domains** (`https://<project>.vercel.app`); step 3 sets a preview's. Use the dashboard (**Settings**, **Environment Variables**) or `vercel env add <NAME> production`.
7. 🐨 Deploy to production with `vercel deploy --prod`, open its URL, and sign in as `leo.martin@kestrelpay.example` with your new password. Ask "How much can I claim a day for meals when I travel for work?".

🦉 Why the migrations run from your machine as the owner, and the app gets `ac_app`. The owner can drop tables and reads every tenant; a request that leaked its URL would leak everything. The app's URL can only do what the `app_role` migration granted, and RLS hides every row whose `tenant_id` isn't the transaction's. The migration that makes `ac_app` can't know its password (a role belongs to the whole server, and migrations are public), so `db:migrate:remote` sets it from `DATABASE_URL` after migrating, then signs in as `ac_app` to prove it can't bypass RLS.

When you're done: production answers, signed in as Leo, with a citation.
