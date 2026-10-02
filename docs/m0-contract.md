# M0 contract (TypeScript)

The shared agreements for the M0 lanes after the base lane. `PLAN.md` is the source of truth for the why; this file fixes the names so the lanes fit together. If a lane has to break this contract, it says so in its report instead of silently diverging. `docs/m0b-contract.md` is the Python predecessor: its fake-workspace and schema sections still describe the behaviour we port, including "Settled during the build".

**M0 is done when** `pnpm ex smoke --json` passes every check listed at the end.

## Lanes and file ownership

| Lane | Owns |
|---|---|
| A. DB + auth + seed | `compose.yaml`, `drizzle.config.ts`, `src/db/**`, `src/lib/auth*.ts`, `src/routes/api/auth/**`, the login UI and the `/me` route, `scripts/seed.ts`, `.env.example` |
| B. fake-workspace + world | `servers/fake-workspace/**`, `src/fixtures/world.ts` + its tests |
| C. Course mechanics | `scripts/ex.ts` + `scripts/ex/**`, `vite-plugins/learn-slots.ts`, `exercises/**`, `src/core/_sample/**`, `.github/**` |
| D. Workflow spike | `src/workflows/**`, `src/routes/api/spike/**`, `docs/workflow-notes.md` |
| Integrator (later) | `ex smoke`, wiring across lanes, docs |

Shared files (`package.json`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`): every lane may add its own dependency, script or plugin entry. Re-read the file right before writing, change only your lines, and run `pnpm install` after. Lane D puts `workflow()` first in the Vite plugins; lane C adds `learnSlots()` right after it.

## Environment

| Var | Default (dev) | Notes |
|---|---|---|
| `AC_ENV` | `dev` | `dev` / `test` / `prod`; dev-only behaviour refuses to run otherwise |
| `DATABASE_URL` | `postgres://ac:ac@localhost:5432/ac` | ParadeDB in Compose |
| `BETTER_AUTH_SECRET` | dev value in `.env.example` | refused in prod if it's the dev value |
| `BETTER_AUTH_URL` | `http://localhost:3000` | |
| `OPENAI_API_KEY`, `COHERE_API_KEY` | unset | not needed in M0 (tests use fakes) |
| `FAKE_WORKSPACE_URL` | `http://localhost:8100` | |
| `AC_CORPUS_DIR` | `fixtures/corpus/build` | read by fake-workspace |
| `AC_ACTIVE_STEP`, `AC_SLOT_ROOT` | unset, `playground` | see Slots |

Ports: app 3000, fake-workspace 8100, ParadeDB 5432 (bound to 127.0.0.1), docling 5001 (M1, not in M0).

## Database (lane A)

- `compose.yaml` at the root runs one service, `paradedb`, image `paradedb/paradedb:0.25.11-pg18`, with `POSTGRES_USER=ac`, `POSTGRES_PASSWORD=ac`, `POSTGRES_DB=ac`, `127.0.0.1:5432:5432`, a named volume and a healthcheck. `pg_search` and `vector` must exist in `ac`.
- Drizzle `drizzle-orm@1.0.0-rc.4` (exact; `@paradedb/drizzle-paradedb@0.5.0` pins it), the `postgres` (postgres.js) driver, `drizzle-kit` at the matching RC. Follow https://www.paradedb.com/docs/start/configure-your-environment#drizzle. Migrations are generated SQL files committed under `src/db/migrations/`; `pnpm db:migrate` applies them.
- Schema: port the M0b `0002_content` design (read it with `git show python-m0b:packages/db/src/ac_db/migrations/versions/0002_content.py` and the models) onto Drizzle, with tenants = better-auth organizations. Every tenant table has `tenant_id` referencing the organization, the same RLS policy pattern (enabled, not forced; `NULLIF(current_setting('app.tenant_id', true), '')`), composite `(tenant_id, id)` FKs, `acl_version_seq`, the closure checks, nullable chunk pages with the paired CHECK, `messages.content` object-or-array, and `outbox` with attempts/last_error/failed_at. No HNSW or BM25 index yet (sections 06 and 07 build them). Auth tables carry no RLS.
- Tests run against throwaway databases created per test run on the same server (the `ac` role is superuser in the image), with a drift test: the migrated database equals what the Drizzle schema implies.

## Auth (lane A)

- better-auth 1.7.7 with the Drizzle adapter, email and password, the admin plugin and the organization plugin; `tanstackStartCookies()` last. CLI `auth` (not `@better-auth/cli`). uuid ids.
- One organization per user: `allowUserToCreateOrganization: false`, a `beforeAddMember` guard, and a session-create hook that sets `activeOrganizationId` from the user's only membership.
- Server helper `getViewer()` (in `src/lib/auth-server.ts`) returns `{ userId, email, username, name, tenant: { id, slug } }` or throws 401, for server functions and routes. `GET /api/me` returns it as JSON.
- A minimal login page (email + password, tenant shown after sign-in, sign out). Emails in dev are logged to the console.
- `pnpm db:seed` (idempotent) reads `world.yaml` through `src/fixtures/world.ts`: creates the `kestrel` and `harbour` organizations, every user (email `<username>@<domain>`, the tenant's password, `emailVerified: true`), their membership (role `admin` for users with the admin realm role, else `member`), and bans `peter.hall` with the admin plugin so his login is refused. Smoke users are no longer needed.

## World (lane B, delivered first)

`src/fixtures/world.ts` ports `ac_fixtures.world` (read it with `git show python-m0b:packages/fixtures/src/ac_fixtures/world.py`): `loadWorld(path?)` validates `fixtures/world.yaml` (zod), and exposes `userId`, `groupId`, `itemId` (uuid5 of `"<tenant>:<kind>:<name>"` with `id_namespace`) and `effectiveGrants(tenant, folder)`. Ids must equal the Python ones, which the committed manifest already uses; a test checks a few against `fixtures/corpus/build/manifest.json`. Lane B messages lane A (`m0-db-auth`) as soon as it's ready.

## fake-workspace (lane B)

- A TS port of the Python service (`git show python-m0b:apps/fake_workspace/...`, tests included) at `servers/fake-workspace/`, on Hono with `@hono/node-server`, started with `pnpm fake-workspace` (tsx) on 8100. Behaviour is `docs/m0b-contract.md` "fake-workspace" plus "Settled during the build", including the round-3 fixes: keyset paging, eTags that change with effective sharing, delta tokens with a history digest (410 across a different history), subscription ids with a per-process nonce, the reset generation, re-authorisation after fault waits.
- New: the directory, scoped by the same per-site bearer tokens, Graph-shaped: `GET /v1.0/sites/{site}/users`, `/groups`, `/groups/{id}/members` (direct, users and groups), `/groups/{id}/transitiveMembers`, all paged like children. Disabled users are listed with `accountEnabled: false`.
- Port the tests to Vitest, keeping real HTTP for the webhook paths.

## Slots and the course (lane C)

- Learnable modules live in `src/core/<area>/<module>.ts` and are imported as `#learn/<area>/<module>`. By default that resolves to the reference file. `package.json` `imports` and `tsconfig` `paths` map `#learn/*` to `./src/core/*` so Node, tsx and the type checker see the reference.
- `vite-plugins/learn-slots.ts` (used in `vite.config.ts` and `vitest.config.ts`) resolves the active step once at startup (`AC_ACTIVE_STEP`, else `.ex/state.json`), and for each slot the step declares, resolves `#learn/<area>/<module>` to `<AC_SLOT_ROOT>/<file>` instead. Everything else resolves to the reference.
- Step frontmatter in `README.md`:
  ```yaml
  ---
  title: Greeting
  type: graded   # graded | guided | lab
  slots:
    _sample/greeting: greeting.ts
  ---
  ```
- Steps on disk, the `ex --json` shapes, the gate rules (tests run from the problem dir against the playground, problem or solution code; problem must fail, solution must pass; solution dirs hold no tests), `ex start` refusing to discard a modified playground without `--force`, and stopping what runs before swapping files: all as `docs/m0a-contract.md` describes them, translated to TS. `pnpm ex <command> [--json]`.
- A hidden `exercises/_smoke` section with one graded step slotting `#learn/_sample/greeting` (`formatGreeting(name) -> "hello <name>"`), whose reference is `src/core/_sample/greeting.ts`.
- CI (`.github/workflows/ci.yml`): pnpm install, lint, format check, typecheck, tests with a ParadeDB service container, and `pnpm ex gate`.

## Workflow spike (lane D)

- Prove Vercel Workflow (`workflow` 5.x) in this app on our Nitro and Vite versions. Issue #4442 broke local dev on `nitro 3.0.260903-beta`; use `workflow@5.0.1` if it's out, else pin or patch the merged fix, and write down which.
- `src/workflows/spike.ts`: a workflow with a step, a hook it waits on (`createHook`), a `sleep`, and a step that writes to a stream (`getWritable`). Server routes: `POST /api/spike` starts it and returns the run id and hook token; `POST /api/spike/resume` resumes the hook; `GET /api/spike/{runId}/stream` reads the stream.
- Answer in `docs/workflow-notes.md`, with evidence: does `start()` work from a server route (and from a `createServerFn`)? Do `#learn/*` imports inside step files go through `learnSlots()` (coordinate with lane C; if Workflow bundles steps outside Vite, say what's needed)? How do we test hooks and sleeps without real waits? Where does local run state live, and how do we cancel open runs (lane C's `ex start` needs it)?

## `ex smoke` checks (integrator)

1. ParadeDB is healthy; `pg_search` and `vector` exist; a BM25 query and a pgvector nearest-neighbour query both return rows, over a probe table that is rolled back afterwards (see "Settled during the build").
2. The app answers on 3000; `leo.martin` signs in with email and password and `GET /api/me` returns tenant `kestrel`; Harbour's `nina.osei` gets `harbour`.
3. `peter.hall` is refused (banned).
4. fake-workspace answers on 8100 with the corpus loaded; the Heron memo (manifest `traps` contains `acl-leak`) has exactly one grant, `write` to `/Kestrel/Exec` by world id; Harbour's token on Kestrel's site is 403; `/Kestrel/Exec`'s transitive members include `daniel.reyes` and not `leo.martin`.
5. The spike workflow starts, waits on its hook, resumes, sleeps, streams, and completes.
6. `pnpm ex gate` passes, and it checked `_smoke.1` and `_smoke.2`.

## Settled during the build

The lanes and the integrator changed or pinned down these points. Where they differ from the sections above, these win.

**Seed and auth**
- The seed creates every user with the world's id: `world.userId(tenant, username)`, a uuid5, so the database, the corpus manifest and fake-workspace name a person by the same id. `GET /api/me` returns it as `userId`, and smoke check 2 compares the two.
- `peter.hall` is banned at creation, through the admin plugin's own fields on `createUser` (`data: { banned: true, banReason }`). A user who is already seeded and later disabled in `world.yaml` is banned on the next run: the seed sets the same fields and ends the user's sessions, which is what the admin plugin's `banUser` does (that endpoint needs an admin's session, and the seed has none). A banned sign-in answers 403 with code `BANNED_USER`.

**fake-workspace** (where it differs from the Python service)
- A path with no route for the method answers 404 `itemNotFound`, where FastAPI answered 405.
- Timestamps carry milliseconds (a JS `Date`), still written with six fraction digits, as Python's `isoformat` does. Changes made through the control API are stamped to the whole second, as before.
- It refuses a corpus whose manifest disagrees with `world.yaml` on any user or group id: the corpus stays unloaded, `/health` says `corpus_loaded: false`, and the Graph routes answer 503 until the corpus is rebuilt.
- It binds to 127.0.0.1 only. It has no auth beyond dev tokens, so nothing off the machine should reach it.

**Switching steps** (`ex start`, `ex reset`, `ex solution`)
- **The pause protocol.** The dev server (through `learnSlots()`) writes `.ex/dev-server.json` once it listens: `{ pid, url, token }`. `POST /__ex/pause` with the headers `x-ex-token` and `x-ex-pid` (the pid of `pnpm ex`) answers 200, and from then on every other request gets 503 with `retry-after: 1`, the local world's queue deliveries included. `POST /__ex/resume` answers 202 and restarts the server. If the paused `ex` dies, the next request lifts the pause. The file is removed when the server closes, and `ex` forgets an entry whose pid is gone.
- **The order:** pause the dev server, cancel the open workflow runs, swap the files, restart the dev server. A failed pause switches nothing. A failed cancel leaves the files as they were and restarts the server on them. A failed restart keeps the switch and says so under `skipped`; the server then restarts on its next request.
- **Cancelling runs** goes through the workflow CLI, which reads the local world's files, so it works whether or not the dev server runs: `workflow inspect runs --status pending|running --json --backend local`, paged by cursor, then `workflow cancel <id> --backend local` for each. Outside `AC_ENV=dev` it is skipped and reported under `skipped`. A run that ended between the listing and its cancel doesn't count as a failure.
- **Edits to a slotted file** restart the dev server, since Workflow rebuilds its step bundle only on a restart. After each restart `learnSlots()` compares the slot root's files with a snapshot taken before it, and restarts again if they changed meanwhile: an edit that lands mid-restart reaches neither the old watcher nor the new one.

**Workflow**
- `patches/@workflow__builders@5.0.1.patch` adds esbuild plugins to the two Workflow builds that resolve imports (the steps bundle and the interim workflow bundle), read from `globalThis[Symbol.for("workflow.esbuildPlugins")]`. `vite.config.ts` and `vitest.config.ts` put `learnSlotsEsbuild()` there. It exists because Workflow bundles step code with esbuild, outside Vite, so without it a step's `#learn/*` import always loads the reference, in dev and under Vitest. 5.0.1 has no option for this. `docs/workflow-notes.md` (b) has the evidence.
- `vitest.config.ts` has two projects. `app` runs every test except `src/workflows/**`. `workflows` stands alone (`extends: false`), because `@workflow/vitest` loads esbuild, which refuses to run under jsdom. It runs in node and keeps its runs and bundles in `node_modules/.cache/workflow-vitest`, away from the dev server's `.workflow-data/`.
- An exercise test that runs a workflow is named `*.workflow.test.ts`. `ex test` and the gate run those in the `workflows` project, from the repo root (workflow ids derive from the working directory), with `AC_WORKFLOW_TEST_ROOT` set to a fresh directory under `node_modules/.cache`. A Vitest inside another Vitest needs its own root, or it overwrites the parent's bundles. The root has to sit inside the repo, where the bundles resolve `workflow`. `_smoke.2` is that shape.

**`ex up` and `ex smoke`**
- `pnpm ex up` refuses without `.env.local`, refuses if a process outside Docker holds 5432, then runs `docker compose up --wait`, `pnpm db:migrate` and `pnpm db:seed`. Every step is safe to repeat. The app (`pnpm dev`) and fake-workspace (`pnpm fake-workspace`) are started by hand, each in its own terminal: they are long-running, they print logs worth reading, and `ex` already pauses and restarts the dev server it finds.
- `ex smoke` finds the stack through the environment, then `.env.local`, then the defaults above: `DATABASE_URL`, `BETTER_AUTH_URL` for the app, `FAKE_WORKSPACE_URL`, `AC_CORPUS_DIR`. Its checks run at once, and each reports its own result.
- Check 1 builds its probe table inside a transaction it rolls back. A temporary table would leave nothing behind too, but `pg_search` 0.25.11 leaks buffer pins on temporary tables: one index build on three rows printed 542 `resource was not closed` warnings. Ordinary tables print none.
- Check 2 signs each user out again, so a smoke run leaves no sessions behind.
- Check 6 runs the whole gate, and fails if the gate didn't reach both `_smoke` steps.
