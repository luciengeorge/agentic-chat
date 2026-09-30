# agentic-chat: plan

A hands-on workshop for building a production-grade AI application: a small version of Cohere's North. You build every layer yourself, one step at a time, against a finished reference app that runs the whole way through.

Status: **planning.** Agreed 2026-09-30; revised the same day for a Python backend, a "no shortcuts" rule, and an independent review (see `HANDOFF.md`). Nothing scaffolded yet. No open questions.

## Why this exists

Cohere turned Lucien down after the onsite (22 Sep 2026). From Cate Ciugureanu's email:

> "Your ability to architect a clean distributed system with webhooks, queues, and background workers showed strong practical execution skills. While your system design and execution skills were strong, we observed opportunities to deepen your expertise in autonomous agent orchestration and state management."

So retrieval is covered properly, and agents (sections 13 to 17) get the most depth. By the end you will have built:

- an agent run stored as a state machine plus an append-only event log
- a run that crashes mid-tool-call and resumes without repeating a side effect
- a run that waits days on a human approval, then carries on
- a conversation that receives two messages at once and stays consistent
- context rebuilt from stored state each turn, and compacted when it grows

## The rule: production tools, built by hand first

Every layer uses what a production team would run. For the tools below, you build a small version yourself first, so you know what the tool does for you. Infrastructure with no hand-built pass (Postgres, Keycloak, Redis, Grafana) is adopted directly.

| You build by hand | Then adopt | Section |
|---|---|---|
| A thin HTTP client for the Responses API | The official `openai` SDK, behind our own interface | 01 |
| A parser: text layer, OCR with confidences, tables | docling | 03 |
| A Postgres job queue (`SKIP LOCKED`, visibility timeout, retries) | Temporal activities | 05 |
| BM25 over an inverted index | OpenSearch | 07 |
| A gateway: JWT check, routing, request ids, token bucket | Envoy + its global rate limit service | 11 |
| A durable agent runtime: checkpoints, resume, idempotent effects | Temporal workflows | 15 |
| The agent loop and run state | Compared against an agent framework, then kept hand-written | 16 |
| Retrieval and faithfulness metrics | Compared against ragas | 18 |

## What we're building

A permissioned assistant and agent platform for **Kestrel Pay**, a fictional 600-person fintech. Employees ask questions over the company's documents and get cited answers; agents take actions with approvals; automations run on triggers.

The seeded corpus contains the traps on purpose:

| Trap | What it tests |
|---|---|
| An M&A memo only execs can see | Permission leaks (09) |
| Scanned and handwritten PDFs | OCR and confidence thresholds (03) |
| A table-heavy quarterly report | Table-aware chunking (04) |
| Two versions of the expenses policy | Conflicting sources (10) |
| A document carrying a prompt injection | Agent safety (17) |
| Contract numbers, error codes, SKUs | Why lexical search exists (07) |
| A 3,000-page regulatory filing | Fan-out ingestion (05) |

**Keycloak** plays the customer's identity provider and directory (like Entra ID): login, users, nested groups, roles. **fake-workspace** plays their SharePoint: folders shared with Keycloak groups, pagination, 429s with `Retry-After`, change webhooks, deletes, moves, permission changes. It's deterministic, so tests can trigger any edge case. A real GitHub connector comes later.

## Architecture

```
                 browser
                    │  httpOnly session cookie (no tokens in the browser)
      ┌─────────────▼─────────────┐          ┌───────────┐
      │ web  TanStack Start (BFF) │◄── OIDC ─►│ Keycloak  │  users, nested groups
      └─────────────┬─────────────┘          └─────▲─────┘
                    │ bearer JWT, fetch streaming    │ JWKS
      ┌─────────────▼─────────────┐                  │
      │ gateway  Envoy            │──────────────────┘  JWT check, routing, timeouts,
      └─────────────┬─────────────┘                     rate limits (Redis)
                    │
      ┌─────────────▼─────────────┐   rows + outbox in one transaction
      │ api  FastAPI              │──────────────┐
      │  chat (streams in-request)│              ▼
      │  retrieval · runs · admin │     ┌────────────────┐
      └──┬────────┬───────▲───────┘     │ relay          │ outbox → Temporal
         │        │       │ run tokens  └───────┬────────┘
  reranker   OpenSearch   │ (Redis Streams)     ▼
                          │             ┌────────────────┐
                          │             │ Temporal       │
                          │             └───────┬────────┘
                          │                     ▼
                  ┌───────┴───────────────────────────────────────┐
                  │ workers (Python, Temporal)                    │
                  │  sync          crawl, delta, webhooks, ACLs   │
                  │  ingest        split, parse, chunk, embed     │
                  │  agents        runs, approvals, timeouts      │
                  │  automations   schedules and triggers         │
                  └───────────────────────────────────────────────┘

  postgres + pgvector · redis · minio · grafana (traces, metrics, logs) · fake-workspace
```

**The state rule.** The api holds no state. Long work runs as Temporal workflows in workers. Product state (conversations, messages, run records, the run event log) lives in Postgres; execution state lives in Temporal's history; the workflow id is the run id. Kill any process at any moment and nothing is lost.

## Design seams (decided after review)

These are where the pieces meet, and where a naive build breaks. Each is a decision, not an open item.

**Slots vs Temporal.** Temporal's Python sandbox re-imports workflow modules on every run and forbids I/O inside them, workers register workflows at start, and changing code under an in-flight run breaks replay. So slots resolve **once, at process start**: `AC_ACTIVE_STEP` is read by a meta-path finder installed before any app import, and playground imports inside workflow code go through `workflow.unsafe.imports_passed_through()`. So a step switch (`ex start`, `ex reset`, `ex solution`) stops the api, workers and relay, terminates the open runs in the dev namespace, swaps the playground files, and only then starts the services again. If termination fails while Temporal is up, or the workers are running while Temporal is unreachable, the switch fails and nothing changes. Between switches the apps run under watchfiles, which restarts them when `playground/` changes.

**Grading with a fake model.** Your prompts, tool schemas and ordering will differ from the reference, so recordings keyed by a request hash can't grade your code. Two tools instead:
- **Scripted fakes** grade steps: `FakeChatModel(turns=[...])` returns scripted outputs, and each test asserts only what matters about the request (the tool was offered, the context contained the chunk).
- **Cassettes**, VCR-style, keyed by test id and call index with the body ignored, replay real API traffic for reference evals and demos. `ex record` refreshes them. They store the raw SSE event stream, for sections 01 and 10.

**Streaming.** Plain chat turns (section 10) stream in-request from the api. Agent runs call the model inside worker activities, and tokens must never enter workflow history. So an activity writes tokens to a **Redis Stream** (`XADD run:{id}`), and the api's SSE endpoint reads from it. The Postgres event log holds step-level events only. The api never uses LISTEN/NOTIFY, because Neon's pooled endpoint (PgBouncer in transaction mode) doesn't support it. Pooled connections set psycopg's `prepare_threshold=None`; workers and the relay use direct connections.

**Two records, one truth.** Section 14 is Postgres-only: the event log has a unique `(run_id, seq)`, runs have a `version` column for optimistic concurrency, and messages carry client idempotency keys. Section 15 adds Temporal and owns the consistency between them: events are written inside activities with deterministic event ids, so a retried activity inserts nothing twice, and the step covers the case where the activity finished but its event insert failed.

**Outbox semantics (section 05).** The relay delivers at least once. A workflow's id is derived from its outbox row, starts use `WorkflowIdConflictPolicy`, and messages into a live conversation use `signal_with_start`. Signals carry ids, and workflows dedupe them. Per-conversation ordering comes from partitioning the relay (`FOR UPDATE SKIP LOCKED`), with one owner per partition at a time: each batch takes the partition's transaction-scoped advisory lock first, because SKIP LOCKED alone would let a second relay publish a later row for a key while the first still holds an earlier one. Rows fail one at a time. A failed start counts an attempt and holds back later rows for its key; after a bounded number of attempts (at once, for an unknown kind) the row is marked failed and skipped, so one poison row can't block the partition. Only per-row errors count as attempts: Temporal being down or overloaded rolls the batch back with nothing counted, so an outage never dead-letters good rows. The lock is keyed on the partition number alone, so every relay must run with the same `AC_RELAY_PARTITIONS`. The step also teaches the other valid shape, **Temporal-first** (start the workflow, which writes the row in its first activity; Temporal's own recommendation), and when each fits: outbox when the write must commit with other data, such as a webhook receipt and its dedupe key; Temporal-first when the workflow owns the lifecycle.

**ACLs across two stores (section 09).**
- Postgres `document_acl` is the **only** authorisation decision point. The ACL fields in OpenSearch and on pgvector rows are recall pre-filters, so a stale index can over-fetch but never leak.
- On an ACL change, Postgres updates first, then OpenSearch runs `update_by_query`.
- Keycloak has no webhooks, so directory sync is a full pull through the admin API plus admin-events polling. `/groups/{id}/children` is paginated, and `/users/{id}/groups` returns direct membership only, so we compute the nested closure ourselves (a member of `Finance/AP` is also in `Finance`).
- Until login lands in section 11, sections 09 and 10 use a dev-only identity header that is refused outside dev.

**Login and SSE (section 11).** The web app is a **backend-for-frontend**: TanStack Start's server holds the tokens and the browser holds only an httpOnly session cookie (the pattern the IETF's browser-apps guidance recommends). The BFF calls Envoy with a bearer token and streams with `fetch` + ReadableStream; `EventSource` can't send headers. Envoy's `jwt_authn` validates at request start only. SSE routes need `timeout: 0s`, a raised `stream_idle_timeout`, and a 15-second heartbeat. Rate-limit descriptors come from JWT claims through dynamic metadata. The api trusts the claims Envoy forwards in `x-jwt-payload`, so it must be reachable only through Envoy: locally it publishes no port, and in the cloud it sits on the private network only. It still takes the tenant from the verified issuer, never from a claim alone. Authenticating the Envoy to api hop (mTLS, or a signed internal header) is a hardening option for later.

**Local reranker.** TEI has no official Apple-silicon image. Locally, a small FastAPI + sentence-transformers service exposes TEI's `/rerank` schema. TEI itself runs in CI and the cloud. Same interface, so section 08 doesn't change.

## Decisions

| Area | Choice | Why | Rejected |
|---|---|---|---|
| Backend language | Python 3.13, uv workspaces | What most AI backends use; the best libraries | TypeScript (kept for web and workshop) |
| Web | TanStack Start as a BFF + Router + Query, shadcn (Base UI), Tailwind | Lucien's stack; keeps tokens out of the browser | Tokens in browser storage |
| API | FastAPI, pydantic v2, async throughout | The standard Python API framework; OpenAPI built in | Flask, Django |
| API contract | FastAPI's OpenAPI → generated TS client (openapi-typescript + openapi-fetch) | Types cross the language boundary without hand-written DTOs | |
| Gateway | Envoy with the global rate limit service on Redis | Industry standard, self-hostable | Managed gateways |
| Identity | Keycloak (OIDC, auth code + PKCE) | The common self-hosted enterprise IdP; doubles as the directory | Rolling our own; better-auth (TypeScript only) |
| Database | Postgres + pgvector: container locally, Neon in the cloud | Source of truth and the only authorisation point | |
| Vector types | `vector`, `halfvec` (fp16), `bit` (binary) with rescoring; `hnsw.iterative_scan` for filtered search | pgvector's real types; iterative scan is the fix for filtered-ANN recall | int8 (pgvector has no int8 type) |
| ORM + migrations | SQLAlchemy 2.0 async, Alembic, psycopg 3, pgvector-python | The Python standard | SQLModel |
| Lexical search | OpenSearch, kept in sync through the outbox; aliases for reindex cutover | What enterprise search runs on | pg_search / lakebase_text (host-specific); Postgres full-text (not BM25) |
| Background work | Temporal for everything: sync, ingestion, agent runs, schedules | Durable steps, retry policies, timers, signals, updates, visibility | Celery, Procrastinate, plain queues |
| DB write → workflow | Transactional outbox + relay (Temporal-first also taught) | A row and its workflow start can never diverge | Dual writes |
| Token streaming | Redis Streams from activities to the api | Tokens stay out of workflow history; works through Neon's pooler | LISTEN/NOTIFY; polling the event log |
| Cache + rate limits | Redis (Valkey) | Rate limits, principal cache, embedding cache, token streams | |
| Files | MinIO locally, S3 in the cloud | S3 API everywhere | |
| Models | OpenAI Responses API via the official SDK behind our interface | Lucien's choice | LangChain, LlamaIndex, OpenAI Agents SDK and Agents API as the main path |
| Chat model | The cheapest current tier by default (confirm `gpt-6-luna` vs `gpt-5.6-luna`); ids in one config file; reasoning effort always explicit | | |
| Embeddings | `text-embedding-3-small` | Its `dimensions` parameter gives the truncation exercise | |
| Reranker | bge-reranker: a sentence-transformers service locally, TEI in CI and cloud | Models run in their own serving layer, never inside the api | Loading models into api processes |
| Parsing | docling in the pipeline; pdfplumber + pytesseract + python-docx for the hand-built version | Build to understand, then use the production parser | |
| Tokens | tiktoken | | |
| Observability | OpenTelemetry with GenAI conventions → Grafana (Tempo, Loki, Prometheus); structlog JSON logs | All three signals, one container in dev | Traces only |
| Tests | pytest + pytest-asyncio with scripted fakes; Temporal's time-skipping test environment; Vitest for web | Free, fast, repeatable; the only way to test "waits days" | Live API calls in tests |
| Code quality | ruff, pyright (strict); oxlint, oxfmt, tsgo on the TypeScript side | | |
| CI | GitHub Actions: lint, types, tests, the step quality gate | | |
| Images | Multi-stage Dockerfiles, non-root | | |

**Model gotcha, carried over from poof:** the GPT-5.6 series defaults to `reasoning: "none"`. Always set reasoning effort explicitly, or agents run with reasoning off and nothing errors. Check whether the same applies to whichever model we pick.

## Deployment profiles

The same images run two ways.

| | Local / on-prem (default while learning) | Cloud |
|---|---|---|
| web | TanStack Start dev server | Vercel |
| Backend services (api, workers, relay, reranker, Keycloak, Envoy) | Docker Compose | Container platform: Fly or Railway, same images |
| Postgres | brew `postgresql@18` + `pgvector` on the host (CI: pgvector container) | Neon: direct connection for workers and relay, pooled for api |
| Temporal | Dev server in Compose | Temporal Cloud or self-hosted |
| OpenSearch | Container | Managed (AWS OpenSearch) or self-hosted |
| Reranker | sentence-transformers service | TEI |
| Files | MinIO | S3 |
| Observability | grafana/otel-lgtm container | Grafana Cloud |
| Models | OpenAI; local models in section 21 | OpenAI |

OCR is CPU-heavy and only ever runs in workers, never inside a request. The full stack runs at once on Lucien's 32 GB Mac; Compose profiles still split infra from apps.

## Repo layout

```
agentic-chat/
  PLAN.md  HANDOFF.md  README.md
  pyproject.toml           uv workspace
  package.json             pnpm workspace (web, workshop)
  apps/
    web/                   TanStack Start BFF: chat, citations, run timeline, approvals, admin
    workshop/              TanStack Start, local only: steps, diffs, tests, labs
    api/                   FastAPI
    workers/               Temporal workers: sync, ingest, agents, automations
    relay/                 outbox → Temporal
    reranker/              sentence-transformers service with TEI's /rerank schema
    fake_workspace/        the customer's drive (service name: fake-workspace)
  packages/                Python libraries
    core/                  settings, logging, tracing, shared types
    db/                    SQLAlchemy models, Alembic migrations
    models/                provider interface, OpenAI, fakes, cassettes, local
    ingest/                connectors, parsers, chunkers
    retrieval/             lexical, dense, RRF, rerank, ACL filter, query rewriting
    identity/              directory sync, principal resolution
    agents/                loop, tool registry, run store, workflows
    evals/                 metrics, judges, runner
  exercises/               00.tour … 22.ship
  playground/              the active step's working copy (git-ignored)
  fixtures/
    corpus/                generators + seeds for Kestrel's documents
    directory/             Keycloak realm export
    golden/                eval questions with labelled chunks
    cassettes/             recorded model traffic
  infra/
    compose.yaml  envoy/  keycloak/  opensearch/  temporal/  VERSIONS.md
  scripts/
    ex                     step CLI (Python); every command supports --json
  docs/
    interview-prep/        the Spotify and Cohere prep material this curriculum draws on
```

## How the workshop works

Each step lives in a folder, laid out like Epic React's workshops:

```
exercises/09.acls/
  README.mdx                     section intro
  01.problem.principals/
    README.mdx                   the task, in product voice; every term defined on first use
    principals.py                inline hints
    test_principals.py           what "done" means
  01.solution.principals/
  02.problem.over-fetch/ …
  FINISHED.mdx                   recap and what to notice
```

**Slots.** The finished app imports each learnable piece through a slot, resolved at process start (see Design seams). `ex start 09.2` copies the step's problem files, but not its tests, into `playground/`, sets the active step, and restarts what needs restarting. It refuses to discard playground changes to another step unless you pass `--force`. So:

- a step folder holds only the files it touches, and a slip in section 4 never blocks section 9
- the tests stay in the problem dir and import through the slot, so they grade your playground copy, and nothing you edit can change them
- the whole stack keeps running, so you also see your code work in the app, the traces and the labs

Commands: `ex up`, `ex down`, `ex list`, `ex start <step>`, `ex test <step>`, `ex reset <step>`, `ex diff <step>`, `ex solution <step>`, `ex record`, `ex fixtures`, `ex gate`, `ex smoke`. Every command takes `--json`; the workshop app shells out to `ex` and reads that output, so the logic lives in one place.

**Hints in the code:**

| | Meaning |
|---|---|
| 👨‍💼 | Product context: why this matters to Kestrel |
| 🐨 | Do this |
| 💰 | A code tip, when you're stuck |
| 🦉 | Why it works this way |
| 📜 | Docs to read |
| 🚨 | What the tests check |
| 💯 | Extra credit |

**Step types.** Every step is tagged in its README frontmatter:
- `graded` (most steps): tests decide when you're done.
- `guided`: a walkthrough or comparison with no pass/fail. Steps 00.1, 00.2, 03.5, 16.6, 18.5, 19.2, and 22.1 to 22.4.
- `lab`: done when an observable result appears in the lab panel.

Section 12 is graded with Vitest instead of pytest.

**Quality gate.** CI runs every `graded` step's tests both ways: against the problem code they must fail, and against the solution code they must pass. That catches a step whose tests grade nothing. Tests live only in the problem dir (a solution dir with `test_*.py` fails the gate), so there is one copy to trust.

**The workshop app** (`apps/workshop`, local only) shows the step list with progress, the README and hints, your files with a diff against the solution, a test runner that streams results, an "open in editor" link, and a **lab panel** per section, wired to the running stack.

## Curriculum (107 steps)

Linear, RAG first, for three reasons:

- **Dependencies:** data flows connectors → parse → chunk → index → retrieve → answer → act, so agents get real tools that fail in real ways.
- **Temporal ramp:** you meet Temporal on simpler ingestion workflows in 05 before the agent workflows in 15.
- **Whole system first:** the tour (00) and the always-running app give you the end-to-end view before any layer is drilled.

Slots are independent, so another order is possible later if wanted.

| # | Section | Steps | You build | Lab |
|---|---|---|---|---|
| 00 | Tour | 2 | Run the stack; follow one question through every service in Grafana | Trace viewer |
| 01 | Model primitives | 4 | Provider interface; a hand-written Responses API client with streaming; the tool-call wire format; structured output and token counting | Request inspector |
| 02 | Connectors | 5 | Connector interface; full crawl with pagination; 429 and `Retry-After` backoff; delta sync and webhooks; deletes and moves | fake-workspace control panel |
| 03 | Parsing | 5 | Text layer vs OCR detection; OCR confidences and a review queue; tables to markdown; page mapping; swap in docling and compare | Parsed-page viewer |
| 04 | Chunking | 4 | Token-based sizing; overlap; structure-aware; table-aware | Chunks drawn over the source |
| 05 | Background work | 5 | A Postgres job queue by hand; ingestion as Temporal activities with retry policies and heartbeats; the outbox and relay (and Temporal-first); fan-out with child workflows; separate task queues for incremental vs backfill | Temporal UI + queue board |
| 06 | Embeddings + vectors | 5 | Batch embedding; pgvector and HNSW (M, ef_search, iterative scan); exact vs ANN recall; dimension truncation; `halfvec` and `bit` with rescoring, plus sizing | Recall vs latency chart |
| 07 | Lexical + hybrid | 5 | BM25 by hand; the OpenSearch index, mappings and analyzers; keeping it in sync; reindex with alias cutover (and dual-index for an embedding model change); RRF | Rankings side by side |
| 08 | Rerank + query | 4 | Cross-encoder rerank and rerank depth; query rewriting and expansion; HyDE; document-level routing | Rankings with rerank deltas |
| 09 | Identity + ACLs | 6 | Directory sync from Keycloak with the nested closure; principal cache and invalidation; ACL stamping, with Postgres as the decision point; the over-fetch filter; ACL sync loop and audit log; tenant isolation (row-level security, which needs the app on a non-owner role, since the table owner bypasses RLS unless it is forced, plus the tenant set per transaction with `SET LOCAL` and an explicit cross-tenant role for the relay; tenant-scoped OpenSearch queries, workflow-id prefixes and per-tenant task queues, per-tenant rate limits and budgets) | User and tenant switcher |
| 10 | Generation + citations | 4 | Prompt assembly and token budget; grounding and abstention; SSE streaming; the citation validator | Prompt inspector |
| 11 | Login + gateway | 5 | OIDC login through the BFF; a gateway by hand (JWT via JWKS, routing, request ids); a token bucket on Redis; Envoy with the global rate limit service; SSE through the BFF and Envoy | Request log |
| 12 | Frontend | 4 | The generated OpenAPI client; streaming chat; citation to page viewer; run timeline and approval inbox | The app itself |
| **13** | **Agents: the loop** | **6** | Tool calls by hand; a typed tool registry (pydantic); per-run caps and budgets; errors fed back to the model; parallel calls; per-user token budgets and a kill switch | Run stepper |
| **14** | **Agents: state** | **6** | Run state machine; the event log with `(run_id, seq)` and optimistic concurrency; rebuilding context from events; streaming step events and tokens (Redis Streams); concurrent messages with idempotency keys; compaction and memory | Live event log |
| **15** | **Agents: durability** | **6** | Checkpoints and resume by hand; idempotent side effects; the run as a Temporal workflow, and two records kept consistent; approvals as signals and updates that wait days (graded with time-skipping); timeouts and cancellation, with heartbeats to cancel a live model call; determinism, versioning and continue-as-new | Kill-the-worker button |
| **16** | **Agents: orchestration** | **6** | Workflows vs agents; routing; an orchestrator with sub-agents as child workflows; automations on schedules and triggers; fan-out with backpressure; the same agent in a framework, compared | Run tree |
| 17 | Safety | 4 | Authorisation as the acting user; the poisoned document; plan-then-execute with an action allowlist; guardrails at the gateway | Red-team runner |
| 18 | Evals | 5 | Golden set; recall@k, MRR and NDCG; claim decomposition; judge calibration; agent task evals in CI, compared with ragas | Eval dashboard |
| 19 | Observability | 4 | GenAI spans; metrics and dashboards; cost per request; conversation log fan-out | Grafana |
| 20 | Debugging drills | 5 | Find the fault: stale ACLs, embedding version mismatch, rerank failing open, a poison message, the 2am schedule | Symptom dashboard |
| 21 | Air-gapped | 3 | Local models; egress blocked on the network; vendored dependencies and images | Egress monitor |
| 22 | Ship it | 4 | web to Vercel; backend images to the container platform; Neon, managed Temporal and OpenSearch, secrets, migrations; CI/CD | |

Section 20 is practice for the debugging-round format: each drill ships a broken system and a symptom, and you find the cause.

## Build plan

Exercises are carved out of a working app. The agent reference is written **before** any exercises, so the run and event schema is settled before dozens of steps depend on it.

| Milestone | Delivers | Done when |
|---|---|---|
| **M0a Infra + tooling** | uv and pnpm workspaces; Compose with every service; Envoy + Keycloak realm; the `ex` CLI with slots; scripted fakes and cassettes; CI; a workshop app shell that lists steps via `ex list --json` | `ex up` then `ex smoke` passes (see appendix) |
| **M0b Data** | Schema and migrations; fixture generators (corpus, realm); fake-workspace | `ex fixtures` builds the corpus deterministically; fake-workspace serves it with ACLs |
| **M1 Reference: RAG** | The finished implementation behind sections 01 to 12, plus the golden set | A question is answered end to end, cited, with ACLs enforced, and the M&A memo never reaches the intern |
| **M2 Reference: agents** | The runtime behind 13 to 17 | A run survives a killed worker mid-tool-call with the side effect happening once; an approval resumes a paused run |
| **M3 Exercises 00 to 12** | Steps, tests, READMEs, labs; the full workshop app | The quality gate passes for every graded step |
| **M4 Exercises 13 to 17** | Steps, tests, READMEs, labs | The quality gate passes |
| **M5 The rest** | Evals, observability, drills, air-gapped, ship | The quality gate passes for all graded steps |

## To verify while scaffolding

These can change details, not the architecture:

- Current OpenAI model ids and prices, and each model's reasoning default
- Python 3.13 vs 3.14 for docling and torch
- pytesseract quality on the synthetic handwriting
- Temporal dev server in Compose, and the worker restart on `ex start`
- Keycloak version and its admin API pagination; Envoy `jwt_authn` with two providers (one per realm)
- Pin exact versions of every image and package in `infra/VERSIONS.md`

## Appendix: M0 spec

Enough for a fresh agent to start without guessing. Versions are pinned at scaffold time.

**Services and local ports**

| Service | Port | Service | Port |
|---|---|---|---|
| web | 3000 | postgres | 5432 |
| workshop | 3100 | redis | 6379 |
| envoy | 8080 (admin 9901) | minio | 9000 (console 9001) |
| api | 8000 (Compose network only) | opensearch | 9200 |
| fake-workspace | 8100 | temporal | 7233 (UI 8233) |
| reranker | 8200 | keycloak | 8081 |
| grafana | 3001 (OTLP 4317/4318) | | |

Published ports bind to 127.0.0.1 only. The api publishes none: it trusts Envoy's `x-jwt-payload`.

**Schema (initial entities)**
- Tenancy: `tenants`; `tenant_id` on every table from the first migration, with row-level security policies (enforced from section 09)
- Identity: `principals` (users and groups mirrored from Keycloak), `group_members` (direct), `group_closure` (computed)
- Content: `documents` (source, external_id, version, content_hash, status, valid_from/valid_to), `document_acl` (principal, allow/deny, acl_version), `chunks` (document, ordinal, text, page range, section, token count, embedding, embedding_model_version)
- Sync and ingest: `sync_state` (connector cursor or delta token), `outbox` (id, kind, payload, partition_key, created_at, published_at, attempts, last_error, failed_at)
- Conversation: `conversations`, `messages` (unique idempotency key)
- Runs: `runs` (status, version, workflow_id, budget), `run_events` (run_id, seq unique, type, payload), `approvals`
- Audit: `retrieval_audit` (user, query hash, returned ids, denied ids, acl_version, timestamp)

**Corpus spec.** About 40 documents across Finance, HR, Legal, Engineering, Sales and Exec. The generators and seeds are committed; the documents themselves are built by `ex fixtures`.
- Native PDFs are rendered from markdown.
- Scanned PDFs are rasterised and noised with Pillow.
- Handwriting uses a handwriting font, rasterised.
- The DOCX files are built with python-docx.
- The 3,000-page filing is generated programmatically.
- Every trap in the table above maps to one named document, and the expenses policy exists in two dated versions.
- A second, small tenant (**Harbour Health**, about 5 documents and 5 users) exists only to prove isolation: nothing of theirs may ever reach a Kestrel user, and vice versa.

**Realm spec.** About 30 users with personas, among them an intern, the CFO, a finance analyst, a platform engineer and an HR partner.
- Group tree: Kestrel → Finance (AP, FP&A), Engineering (Platform, Payments), HR, Legal, Exec.
- Roles: admin and employee.
- One Keycloak realm per tenant (`kestrel`, `harbour`), like each customer bringing its own IdP; Envoy trusts both issuers. Shipped as realm exports in `fixtures/directory/`.

**Provider interface (sketch)**
```python
class ChatModel(Protocol):
    async def respond(self, input, *, tools=None, reasoning, stream=False) -> Response | AsyncIterator[Event]: ...
class EmbeddingModel(Protocol):
    async def embed(self, texts: list[str], *, dimensions: int | None = None) -> list[list[float]]: ...
class Reranker(Protocol):
    async def rerank(self, query: str, docs: list[str], *, top_n: int) -> list[tuple[int, float]]: ...
```
Implementations: OpenAI, `FakeChatModel(turns=[...])`, cassette-backed, and local (section 21).

**`ex smoke`** checks that every service is healthy; that a seeded user logs in through the BFF and the resulting JWT is accepted by Envoy; that the api `/health` answers through Envoy; that an outbox row makes the relay start a hello workflow, which completes; that the fake model answers; and that the workshop app lists the sections.

## Unresolved questions

None. Multi-tenancy is in scope (09.6, `tenant_id` from M0); the path is linear, RAG first.
