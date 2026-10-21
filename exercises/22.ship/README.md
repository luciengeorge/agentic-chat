---
title: Ship it
---

# Ship it

Everything so far ran on your laptop: the app on :3000, ParadeDB in Docker, Workflow's runs as files in `.workflow-data/`, and four background loops inside `pnpm dev`. Kestrel's staff can't use any of that. This section puts the assistant on the internet with your own accounts: the app and its workflows on Vercel, the database on Fly, secrets where only the server reads them, and CI in front of every deploy.

You do the deploying. The steps are walkthroughs: commands to copy, and what you should see after each one. Nothing here was deployed for you, and nothing costs money until you create the database in step 2 (about $10 a month on Fly) or move Vercel to Pro.

## Terms

- A **deployment** is one build of the app, served at its own URL. A **preview** deployment is built from a branch or pull request; **production** is the one your real domain points at, built from `main`.
- A **function** is how Vercel runs server code: started on demand, kept warm for a while, then stopped. Nothing stays running between requests unless a request is in flight.
- A **region** is where those functions run. Vercel's default is `iad1` (Washington, D.C.); this section puts both the functions and the database in London, so no query has to cross the Atlantic.
- A **cron job** is a request on a schedule. Vercel Cron sends `GET` to a path you name in `vercel.json`, in UTC, on production deployments only.
- A **secret** is a value the server needs and nobody else may see: a database password, an API key. On Vercel it's an environment variable set in the project's settings.
- **CI** (continuous integration) runs the checks on every push. **CD** (continuous delivery) deploys what passed.

## What a deploy needs that dev didn't

| In `pnpm dev`                                                  | On Vercel                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Server plugins loop forever: relay, scheduler, sync, job queue | No process stays up. Four cron routes (`/api/cron/*`), each one bounded pass, called by Vercel Cron    |
| A kick after commit wakes the relay at once                    | The kick has no listener in another function: rows wait for the next minute's relay                    |
| Workflow's local world: files on disk, a queue in memory       | Vercel's world: runs stored by Vercel, steps delivered through Vercel Queues, each in its own function |
| `.env.local`, with public dev secrets                          | Variables in Vercel's settings; the server refuses to start without them, and names each one missing   |
| ParadeDB in Docker, migrated by `pnpm db:migrate`              | ParadeDB on Fly, migrated by `pnpm db:migrate:remote`, with the same image and the same `ac_app` role  |
| fake-workspace on :8100                                        | Not deployed: no sync, no ingest, no mail. The documents arrive as a copy of your dev database         |

## The steps

1. **The app and workflows to Vercel.** Build exactly what Vercel builds, read its functions and their sizes, link a project, and watch the first deploy refuse to start.
2. **ParadeDB in the cloud, secrets and migrations.** Fly, Railway and ParadeDB Cloud compared on price; ParadeDB on a Fly Machine; the migrations as the owner, the app role's login, the data copied, and new passwords.
3. **Hooks and streams on a Vercel preview.** What changes when Workflow runs on Vercel, and a checklist: `pnpm ex smoke --target <url>` against the preview.
4. **CI and CD.** Previews per pull request, production from `main`, the gate in CI, migrations before production, and the cron jobs.

All four are `guided`: no tests decide when you're done. Each README says what you should see, and its solution says what it means.

## What you need

- A Vercel account (Hobby is free; per-minute cron jobs need Pro, $20 a month). The `vercel` CLI is installed.
- A Fly account with a card on file. `fly` is installed (v0.4.102).
- Your OpenAI and Cohere keys, as in `.env.local`.
- This repo on GitHub, for step 4.

No lab page for this section: the deploy is the lab.
