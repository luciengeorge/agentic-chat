# agentic-chat

A hands-on workshop for building a production-grade AI application: a small version of Cohere's North, for a fictional
600-person fintech, Kestrel Pay. You build the AI layers yourself, one step at a time, against a finished reference app
that runs the whole way through.

- [`PLAN.md`](./PLAN.md): what we're building and why, the curriculum and the milestones.
- [`docs/agent-notes.md`](./docs/agent-notes.md): how the learner learns, the house rules, and the traps in this environment.
- [`AGENTS.md`](./AGENTS.md): the code conventions, for coding agents and people alike.

The app started from [`tanstack-starter-template`](https://github.com/luciengeorge/tanstack-starter-template), with
Convex, Sentry, PostHog, Resend, react-email, Polar and the analytics removed.

## What runs where

The app is one web server with two helpers. All three listen on your machine only.

| Part           | Port | What it is                                                                                                      |
| -------------- | ---- | --------------------------------------------------------------------------------------------------------------- |
| the app        | 3000 | The TanStack Start server: the pages, the API routes and the workflows                                          |
| fake-workspace | 8100 | A stand-in for the customer's file store, shaped like SharePoint. It serves the documents and who may read them |
| ParadeDB       | 5432 | Postgres with keyword search (`pg_search`, BM25) and vectors (`pgvector`), run by Docker Compose                |

A few words used below:

- A **tenant** is one customer organisation. There are two, Kestrel Pay (`kestrel`) and Harbour Health (`harbour`),
  and neither may see the other's data.
- A **migration** is a SQL file that changes the database's tables. **Seeding** fills the database with the tenants and
  people from `fixtures/world.yaml`.
- A **workflow** is code that can pause and pick up where it stopped, even after the server restarts. The app runs them
  with [Vercel Workflow](https://useworkflow.dev), which keeps its local runs in `.workflow-data/`.

## Getting started

You need Node 22 or later, pnpm 10 or later, and Docker (OrbStack works).

```bash
cp .env.example .env.local    # dev values that work as they are
pnpm install
pnpm ex up                    # start ParadeDB, apply the migrations, seed the world
```

`pnpm ex up` refuses to start when something outside Docker already holds port 5432 (a Postgres from Homebrew, say),
since that would answer in ParadeDB's place. It does the same as these three, which you can also run by hand:

```bash
pnpm db:up && pnpm db:migrate && pnpm db:seed
```

Then start the app and fake-workspace, each in its own terminal:

```bash
pnpm dev                      # http://localhost:3000
pnpm fake-workspace           # http://localhost:8100
```

Sign in at http://localhost:3000/login as `leo.martin@kestrelpay.example` with the password `dev-password`. Every
seeded person has that password; `peter.hall` has left the company, so his sign-in is refused.

Last, check the whole stack:

```bash
pnpm ex smoke
```

It runs six checks, and each prints `ok` or `FAIL` with what it found:

1. ParadeDB answers a BM25 search and a vector search.
2. `leo.martin` and `nina.osei` sign in, and the app puts each in the right tenant.
3. `peter.hall` is refused.
4. fake-workspace shares the confidential Project Heron memo with the executives only, keeps Harbour out of Kestrel's
   files, and knows who is in which group.
5. A small workflow starts, waits to be resumed, sleeps, streams its output and finishes.
6. The exercise grader works (see `pnpm ex gate` below).

`pnpm ex down` stops ParadeDB; `pnpm ex down --volumes` deletes its data too.

## The course

The exercises live in `exercises/`, one folder per section, and each step has a problem folder and a solution folder.
A step's code goes into `playground/`, which is yours to edit. The app loads your playground file in place of its own
for the module the step is about (a **slot**), so you see your code run in the real app.

```bash
pnpm ex list                  # the sections and steps, with your progress
pnpm ex start <step>          # copy a step's problem files into playground/, e.g. pnpm ex start 00.1
pnpm ex test <step>           # grade your playground against the step's tests
pnpm ex diff <step>           # how your playground differs from the solution
pnpm ex solution <step>       # replace your playground with the solution
pnpm ex reset <step>          # throw away your changes and start the step over
pnpm ex gate                  # check every graded step: fails on its problem code, passes on its solution
```

`ex start` won't discard changes you made to another step unless you add `--force`. When it switches steps, it pauses
the running dev server, cancels any workflow runs still open (their code is about to change), swaps the files and
restarts the server. Every `ex` command takes `--json` for output a script can read.

## Stack

| Layer           | Pick                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Framework       | [TanStack Start](https://tanstack.com/start) (Vite + Nitro)                                           |
| Routing         | TanStack Router (file-based)                                                                          |
| Database        | [ParadeDB](https://www.paradedb.com) (Postgres, pg_search, pgvector) through Drizzle                  |
| Auth            | [better-auth](https://www.better-auth.com), with organizations as tenants                             |
| Workflows       | [Vercel Workflow](https://useworkflow.dev)                                                            |
| AI              | [Vercel AI SDK 7](https://ai-sdk.dev) (`ai`, `@ai-sdk/openai`, `@ai-sdk/react`)                       |
| UI              | [shadcn/ui](https://ui.shadcn.com) Base UI variant + Tailwind v4 + [hugeicons](https://hugeicons.com) |
| Forms           | TanStack Form + Zod                                                                                   |
| Data fetching   | TanStack Query                                                                                        |
| Tooling         | oxlint + oxfmt + tsgo (no eslint, no prettier, no tsc), Vitest                                        |
| Package manager | pnpm                                                                                                  |
| Hosting         | Vercel                                                                                                |

## Environment variables

[`.env.example`](./.env.example) lists them all, with the dev values. Every process loads `.env.local` first: the app,
fake-workspace, `pnpm ex` and the `db:` scripts. A variable already set in your shell wins over the file.

`AC_ENV` says which environment a process runs in: `dev`, `test` or `prod`. Leave it out and you get prod, except
under the dev server (dev) and Vitest (test). So a production build that forgets it still runs as prod. The secrets in
`.env.example` are public on purpose: in prod the app refuses to start on them, or on any secret shorter than 32
characters. The model keys are only needed to talk to the models; the tests use fakes.

## Scripts

```bash
pnpm dev              # the app on :3000 (loads .env.local)
pnpm fake-workspace   # fake-workspace on :8100, restarting on change
pnpm build            # production build into .output/
pnpm start            # run the production build, as prod (it reads no .env.local: set its variables yourself)
pnpm test             # vitest (the database tests skip when ParadeDB is down; AC_REQUIRE_POSTGRES=1 fails instead)
pnpm typecheck        # tsgo --noEmit
pnpm lint             # format the code with oxfmt, then lint it with oxlint (lint problems are reported, not fixed)
pnpm lint:check       # CI: the same, without writing the formatting
pnpm format:check     # oxfmt over the whole repo
pnpm db:up            # ParadeDB in Docker Compose
pnpm db:migrate       # apply the migrations in src/db/migrations
pnpm db:seed          # add the tenants and people from fixtures/world.yaml (safe to repeat)
pnpm db:generate      # write a migration from changes to src/db/schema
pnpm db:migrate:remote    # migrate a cloud database (both URLs from the shell, never .env.local)
pnpm db:rotate-passwords  # one new password for every person on a cloud copy (ACCOUNT_PASSWORD)
```

## Deploying

Section 22 (`exercises/22.ship/`) is the walkthrough; this is the summary. Nothing in the repo deploys by itself.

| Part                   | Where                                                              | How                                                                                      |
| ---------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| The app, its workflows | Vercel, functions in `lhr1`                                        | `vercel link`, then the Git integration or `vercel deploy`; Workflow uses Vercel's world |
| ParadeDB               | a Fly Machine with a 10 GB volume, `paradedb/paradedb:0.26.1-pg18` | `pnpm db:migrate:remote` as the owner, then the data copy and new passwords (22.2)       |
| fake-workspace         | not deployed                                                       | the sync cron route skips while `FAKE_WORKSPACE_URL` is unset                            |

**Environment.** [`.env.example`](./.env.example) marks each variable a deploy needs with `[prod: required]` and says where it comes from. A production server refuses to start until all eight are set (`DATABASE_URL`, `DATABASE_ADMIN_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `TOAST_SECRET`, `CRON_SECRET`, `OPENAI_API_KEY`, `COHERE_API_KEY`), names every one that's missing, and refuses the public dev values of the three secrets (`src/lib/env-check.ts`, `src/lib/auth-env.ts`).

**Background work.** In `pnpm dev`, server plugins run the outbox relay, the scheduler, the periodic sync and the agent queue. On Vercel nothing stays running, so `vercel.json` schedules a cron route for each (`/api/cron/relay`, `scheduler` and `agent-queue` every minute, `sync` every five). Each does one bounded pass, and refuses any caller without `Authorization: Bearer $CRON_SECRET`. Vercel's Hobby plan allows only daily cron jobs and refuses a deploy with these schedules; per-minute needs Pro.

**Checking a deploy.** `pnpm ex smoke --target <url>` runs the checks that make sense over HTTP: the security headers, the dev-only routes off, the cron routes refusing strangers, sign-in, a cited answer, and two agent runs through their approval hook. `SMOKE_PASSWORD`, `SMOKE_CRON_SECRET` and `VERCEL_AUTOMATION_BYPASS_SECRET` (in `.env.example`) adapt it to a deploy.

**CI and CD.** `.github/workflows/ci.yml` runs lint, types, the tests against a ParadeDB service, the build, a boot check of the built server, and the gate. `.github/workflows/deploy.yml` runs after a green CI and does nothing until its secrets exist: with `DATABASE_ADMIN_URL` and `DATABASE_URL` it migrates production on `main`; with `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` it also deploys (previews for pull requests, production for `main`) in place of Vercel's Git integration.

## Folder structure

```
.
├── src/
│   ├── core/               # the modules the exercises teach, imported as #learn/<area>/<module>
│   ├── db/                 # Drizzle schema, migrations and the seed
│   ├── fixtures/world.ts   # loads fixtures/world.yaml
│   ├── lib/                # auth, logger, toast, server functions
│   ├── routes/             # file-based routes, the API routes included
│   └── workflows/          # Vercel Workflow code
├── servers/fake-workspace/ # the stand-in file store
├── exercises/              # the course: sections, steps, tests
├── scripts/                # the `ex` CLI and the seed script
├── vite-plugins/           # learn-slots: points #learn imports at your playground
├── fixtures/
│   ├── world.yaml          # tenants, people, groups, folders, sharing, facts
│   └── corpus/             # the documents the workshop searches (see its README)
├── patches/                # a pnpm patch to Workflow's bundler (see docs/workflow-notes.md)
├── docs/                   # the M0 contract, Workflow notes, interview prep, the Python milestones
├── compose.yaml            # ParadeDB
├── nitro.config.ts         # security headers (CSP, COOP, HSTS, etc.)
└── vite.config.ts          # Vite, TanStack Start, Workflow, learn-slots
```

## Adding shadcn components

```bash
pnpm dlx shadcn@latest add card field input spinner sonner
```

This repo uses **Base UI**, not Radix. The CLI picks the right variant from `components.json`.

## License

UNLICENSED.
