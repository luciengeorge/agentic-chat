# M0a contract

The shared agreements for the M0a lanes. `PLAN.md` is the source of truth for the why; this file fixes the names so the lanes fit together. If a lane has to break this contract, it says so in its report instead of silently diverging.

## Lanes and file ownership

| Lane | Owns |
|---|---|
| A. Python core | `pyproject.toml` (root), `uv.lock`, `packages/*`, `apps/{api,workers,relay,reranker,fake_workspace}/src` + their `pyproject.toml` + tests, ruff/pyright config (in root `pyproject.toml`) |
| B. Infra | `infra/**`, `apps/*/Dockerfile`, `.dockerignore`, `.env.example` |
| C. `ex` + slots | `scripts/ex/**`, `exercises/**`, `.github/**`, `.gitignore`, root `conftest.py`, `packages/core/src/ac_core/slots.py` + its tests |
| D. TypeScript | `package.json` (root), `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `apps/web/**`, `apps/workshop/**`, oxlint/oxfmt/tsconfig at root |

Adding a dependency to your own member's `pyproject.toml` and running `uv sync` is fine for any lane. Don't edit files another lane owns; note what you need in your report.

## Python

- Python 3.13 (`.python-version`), uv workspace, `uv_build` backend, `src/` layout.
- Import names: `ac_core`, `ac_db`, `ac_models`, `ac_api`, `ac_workers`, `ac_relay`, `ac_reranker`, `ac_fake_workspace`, `ac_ex`.
- Quality: ruff (lint + format), pyright strict, pytest + pytest-asyncio. `uv run ruff check`, `uv run ruff format --check`, `uv run pyright`, `uv run pytest` all pass from the repo root.
- Entry points: `uv run ex` (console script from `ac_ex`); each app runnable as `python -m ac_<app>`.

## Environment variables

Settings live in `ac_core.settings` (pydantic-settings). Defaults target the host (`localhost`); Compose overrides with service names.

| Var | Default (host) | Notes |
|---|---|---|
| `AC_ENV` | `dev` | `dev` / `test` / `prod`. Dev-only features refuse to run otherwise |
| `AC_DATABASE_URL` | `postgresql+psycopg://ac:ac@localhost:5432/ac` | direct; workers, relay, migrations |
| `AC_DATABASE_URL_POOLED` | same as above | api; set `prepare_threshold=None` on it |
| `AC_REDIS_URL` | `redis://localhost:6379/0` | |
| `AC_TEMPORAL_ADDRESS` | `localhost:7233` | |
| `AC_TEMPORAL_NAMESPACE` | `default` | |
| `AC_OPENSEARCH_URL` | `http://localhost:9200` | |
| `AC_S3_ENDPOINT` / `AC_S3_ACCESS_KEY` / `AC_S3_SECRET_KEY` | `http://localhost:9000` / `minioadmin` / `minioadmin` | |
| `AC_RERANKER_URL` | `http://localhost:8200` | |
| `AC_KEYCLOAK_URL` | `http://localhost:8081` | issuers are `<url>/realms/<tenant>`; the api trusts only these |
| `AC_RELAY_PARTITION` / `AC_RELAY_PARTITIONS` | `0` / `1` | |
| `AC_RELAY_MAX_ATTEMPTS` | `5` | failed starts before the relay gives up on a row |
| `AC_MODEL_PROVIDER` | `fake` | `fake` / `cassette` / `openai` |
| `OPENAI_API_KEY` | unset | only needed when provider is `openai` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | standard OTel var |
| `AC_ACTIVE_STEP` | unset | overrides `.ex/state.json` (see Slots); read by `ac_core.slots`, not settings |
| `AC_SLOT_ROOT` | `playground` | where slot files are loaded from; same |
| `AC_REQUIRE_POSTGRES` | unset | `1` makes the Postgres tests fail instead of skip when it's unreachable (CI sets it) |

## Services

Ports are the `PLAN.md` appendix. Compose service names: `redis`, `minio`, `opensearch`, `temporal`, `keycloak`, `envoy`, `ratelimit`, `grafana`, `api`, `workers`, `relay`, `reranker`, `fake-workspace`. `web` and `workshop` run on the host as dev servers. Postgres also runs on the host: brew `postgresql@18` with `pgvector` on 5432 (role, password and database all `ac`); containers reach it at `host.docker.internal:5432`.

Published ports bind to `127.0.0.1` only. The api publishes no port: it trusts `x-jwt-payload`, so only Envoy may reach it, over the Compose network. `ex up` first checks every published port and fails, naming the port and the process (from `lsof`), if anything other than Docker/OrbStack already listens there.

Compose profiles: `infra` (datastores, Temporal, Keycloak, Envoy, ratelimit, Grafana) and `apps` (the Python services). The Python app containers bind-mount the repo at `/repo`, keep their venv at `/opt/venv` (`UV_PROJECT_ENVIRONMENT`), and all run under `watchfiles` via `infra/python/dev-run.sh` (not uvicorn `--reload`), which restarts the process when `packages/`, the app's `src/` or `playground/` change.

Every Python service exposes `GET /health` → `{"status": "ok", "service": "<name>"}`. The workers and relay, which aren't HTTP services, expose it on an internal port (workers 8300, relay 8301).

## Identity

- Two Keycloak realms, `kestrel` and `harbour`, shipped as realm exports in `fixtures/directory/` (lane B writes minimal ones; M0b fills them in).
- `KC_HOSTNAME=http://localhost:8081`, so the token issuer is `http://localhost:8081/realms/<realm>` no matter who fetched the token.
- Client `web-bff`: confidential, auth code + PKCE, secret `dev-web-bff-secret`, redirect `http://localhost:3000/auth/callback`, post-logout `http://localhost:3000/`.
- Access tokens carry `aud: agentic-api` (audience mapper) and `tenant: <realm name>` (hardcoded-claim mapper).
- Smoke users: `smoke.kestrel` in `kestrel`, `smoke.harbour` in `harbour`, password `smoke-password`.

## Gateway (Envoy, :8080)

- `GET /health` → api `/health`, no auth.
- `/v1/*` → api, JWT required from either issuer (JWKS fetched in-network from `http://keycloak:8080/realms/<realm>/protocol/openid-connect/certs`), audience `agentic-api`. Envoy forwards the verified payload in `x-jwt-payload` (base64url JSON) and sets `x-request-id`.
- Global rate limit via `envoyproxy/ratelimit` on Redis, descriptor from the `sub` claim, a generous limit (smoke doesn't hit it).
- SSE routes come later (section 11); leave a commented route template with `timeout: 0s` and a raised `stream_idle_timeout`.

## api

- `GET /health` as above.
- `GET /v1/me` → `{"sub", "tenant", "issuer", "request_id"}`, taken from `x-jwt-payload`. 401 if the header is missing. The api trusts Envoy for signature checks; it never sees raw tokens.
- The tenant is the realm of the verified issuer (`iss` must be one of `AC_KEYCLOAK_URL/realms/<tenant>`, else 401). A `tenant` claim that disagrees with it is 403.

## Database (M0a subset)

Alembic in `ac_db`, first migration `0001_init`:
- `tenants(id uuid pk, slug text unique, name text, created_at timestamptz)`, seeded with `kestrel` and `harbour`.
- `outbox(id uuid pk, tenant_id uuid fk, kind text, payload jsonb, partition_key text, created_at timestamptz default now(), published_at timestamptz null, attempts int not null default 0, last_error text null, failed_at timestamptz null)`, with an index on pending rows (unpublished and not failed).
- Every tenant-scoped table gets `tenant_id` plus an RLS policy on `NULLIF(current_setting('app.tenant_id', true), '')::uuid` (an empty setting matches nothing instead of erroring). RLS is enabled but not forced until section 09.
- `ac_db.models` matches the migrations exactly; a test runs alembic's `compare_metadata` against a migrated database.
- The rest of the appendix schema is M0b.

## Relay and the hello workflow

- Task queue `ac-default`. Workers register `HelloWorkflow` (input `{"name": str}`, returns `"hello <name>"`) with one activity, `format_greeting`, that calls `ac_workers.hello.greeting.format_greeting(name)`. That function is the sample slot (see below).
- The relay claims unpublished rows with `FOR UPDATE SKIP LOCKED`, in batches, for partition `AC_RELAY_PARTITION` of `AC_RELAY_PARTITIONS` (hash of `partition_key`). Each batch first takes `pg_try_advisory_xact_lock` on the partition and skips the batch if another relay holds it, so a partition has one owner and each key stays in order. For `kind = "hello"` it starts `HelloWorkflow` with workflow id `<tenant_slug>:hello:<outbox_id>`, `id_conflict_policy=USE_EXISTING`, `id_reuse_policy=REJECT_DUPLICATE`, then sets `published_at`. At-least-once delivery.
- Rows fail one at a time. A failed start increments `attempts`, records `last_error`, and holds back later rows with the same `partition_key` in that batch. After `AC_RELAY_MAX_ATTEMPTS` attempts, or at once for an unknown kind, the row gets `failed_at` and is never claimed again.
- `format_greeting` runs with an explicit retry policy (5 attempts, exponential backoff, `NotImplementedError` non-retryable). Later activities copy that shape.

## Models

`ac_models` holds the three Protocols from the `PLAN.md` appendix, `FakeChatModel(turns=[...])` (scripted outputs, records the requests it received so tests can assert on them), and a cassette recorder/replayer keyed by `(test_id, call_index)` that ignores the body and stores raw SSE event streams. OpenAI goes behind the Protocol with the official SDK; model ids live in one config module. Reasoning effort is a required argument, never defaulted.

## Slots

- A step's `README.mdx` frontmatter declares its slots:
  ```yaml
  ---
  title: Greeting
  type: graded   # graded | guided | lab
  slots:
    ac_workers.hello.greeting: greeting.py
  ---
  ```
- `ac_core.slots.install()` puts a meta-path finder first on `sys.meta_path`. At install time it resolves the active step (`AC_ACTIVE_STEP`, else `.ex/state.json` → `active_step`, else none) and the slot root (`AC_SLOT_ROOT`, default `playground/`, relative to the repo root). For each module named in that step's `slots`, the finder loads the file from the slot root instead of the reference module. Every other module imports normally, so only the active step is swapped.
- It resolves once per process and never re-reads. Every app entry point calls `install()` before any other `ac_*` import; the root `conftest.py` does the same for tests.
- Workflow code imports slot modules inside `workflow.unsafe.imports_passed_through()`.
- `ex test` and `ex gate` always run the tests from the step's problem dir, which the learner doesn't edit, and point `AC_SLOT_ROOT` at the code under test: `playground/`, the problem dir or the solution dir. The gate runs the same tests twice: against the problem code they must fail, against the solution code they must pass.

## Steps on disk

```
exercises/<NN>.<slug>/README.mdx                 frontmatter: title
exercises/<NN>.<slug>/<MM>.problem.<slug>/        README.mdx (frontmatter above), code, test_*.py
exercises/<NN>.<slug>/<MM>.solution.<slug>/       README.mdx, code; no tests (the gate rejects test_*.py here)
exercises/<NN>.<slug>/FINISHED.mdx
```
Step id is `<NN>.<M>` (`09.2`). A section or step with `hidden: true` in its frontmatter shows up only with `ex list --all`. M0a ships `exercises/00.tour` (two guided stubs) and a hidden `exercises/_smoke` section with one graded step that slots `ac_workers.hello.greeting`, to prove slots and the gate.

`ex start <step>` copies the problem dir's code files (everything but `README.mdx` and `test_*.py`) flat into `playground/` and writes `.ex/state.json`. If the playground differs from both the problem and the solution copy of the active step, it refuses unless `--force`. Both `playground/` and `.ex/` are git-ignored.

`ex start`, `ex reset` and `ex solution` switch the slotted code in this order: stop whichever of `api`, `workers` and `relay` are running; terminate the open workflow runs in the dev namespace; replace the playground files; start the stopped services again. If Temporal is reachable but termination fails, the command fails (non-zero, JSON error), the files stay as they were, and the services restart on the old code. If Temporal isn't running there are no runs to close, so the switch goes ahead and reports it under `skipped`.

## `ex --json` shapes

```jsonc
// ex list --json
{"sections": [{"id": "00", "slug": "tour", "title": "Tour", "hidden": false,
  "steps": [{"id": "00.1", "slug": "...", "title": "...", "type": "guided",
    "problem_dir": "exercises/00.tour/01.problem.x", "solution_dir": "exercises/00.tour/01.solution.x",
    "status": "not_started"}]}]}   // status: not_started | active | passed

// ex test <step> --json   (--target playground|problem|solution, default playground)
{"step": "00.1", "target": "playground", "passed": true,
 "tests": [{"nodeid": "...", "outcome": "passed", "duration_s": 0.01, "message": null}]}

// ex smoke --json
{"passed": false, "checks": [{"name": "envoy /health", "passed": true, "detail": null, "duration_s": 0.05}]}
```
Every command takes `--json`. On error, `--json` prints `{"error": "...", "detail": ...}` and exits non-zero.

## `ex smoke` checks

1. Every Compose service is healthy, and web (3000) and workshop (3100) respond.
2. Login: an httpx client runs the real auth code flow as `smoke.kestrel`: `GET :3000/auth/login` → the Keycloak form (`#kc-form-login`) → POST the credentials → callback → the session cookie. Then `GET :3000/api/me` (the BFF calls Envoy `/v1/me` with the bearer token) returns `tenant == "kestrel"`.
3. `GET :8080/health` answers through Envoy, and `GET :8080/v1/me` without a token is 401.
4. Insert a `hello` outbox row → the relay starts the workflow → the result is `"hello smoke"` within 30 seconds.
5. `FakeChatModel` answers a scripted turn.
6. `GET :3100/api/steps` lists section `00`.

## Web BFF (`apps/web`)

TanStack Start. Routes: `/auth/login?tenant=kestrel|harbour` (default `kestrel`), `/auth/callback`, `/auth/logout`, `/api/me`. Tokens live server-side in Redis (`bff:session:<id>`, with a TTL), and the browser holds only the httpOnly, SameSite=Lax `ac_session` cookie. The BFF refreshes access tokens itself. A session carries a `version`; a refresh writes back with a compare-and-set (a Lua script: the key must still exist at the version it read, and it keeps its remaining TTL), so a logout during a refresh stays logged out. `returnTo` is resolved against `AC_WEB_ORIGIN` and kept only if it stays same-origin. Keycloak over plain http is allowed only when `AC_ENV=dev`. The UI is a shell: signed-in user, tenant, and a sign-out button.

## Workshop app (`apps/workshop`)

TanStack Start, local only. `GET /api/steps` shells out to `uv run ex list --json` from the repo root and returns its output. The UI is a shell: the section and step list with status.
