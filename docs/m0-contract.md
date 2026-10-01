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

1. ParadeDB is healthy; `pg_search` and `vector` exist; a BM25 query over a temporary table and a pgvector nearest-neighbour query both return rows.
2. The app answers on 3000; `leo.martin` signs in with email and password and `GET /api/me` returns tenant `kestrel`; Harbour's `nina.osei` gets `harbour`.
3. `peter.hall` is refused (banned).
4. fake-workspace answers on 8100 with the corpus loaded; the Heron memo (manifest `traps` contains `acl-leak`) has exactly one grant, `write` to `/Kestrel/Exec` by world id; Harbour's token on Kestrel's site is 403; `/Kestrel/Exec`'s transitive members include `daniel.reyes` and not `leo.martin`.
5. The spike workflow starts, waits on its hook, resumes, sleeps, streams, and completes.
6. `pnpm ex gate` passes on `_smoke.1`.
