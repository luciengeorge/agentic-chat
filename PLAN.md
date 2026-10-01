# agentic-chat: plan

A hands-on workshop for building a production-grade AI application: a small version of Cohere's North. You build the AI layers yourself, one step at a time, against a finished reference app that runs the whole way through.

Status: **restarting on TypeScript** (1 Oct 2026, branch `ts-restart`). The Python stack got as far as M0b and is tagged: `python-m0a` (merged to `main`) and `python-m0b` (reviewed, not merged). `HANDOFF.md` §6 to §8 tells that story. Next: M0, below.

## Why this exists

The goal is hands-on depth in what makes production AI systems hard.



So retrieval is covered properly, and agents (sections 13 to 17) get the most depth. By the end you will have built:

- an agent run stored as a state machine plus an append-only event log
- a run that crashes mid-tool-call and resumes without repeating a side effect
- a run that waits days on a human approval, then carries on
- a conversation that receives two messages at once and stays consistent
- context rebuilt from stored state each turn, and compacted when it grows

## The rule: build it small by hand, then adopt the production tool

Lucien, on the restart: "the main goal is for me to learn everything about agent orchastration, parsing, vector searching, bm25, reranking, etc. so instead of building everything from scratch, let's use a framework i am familiar with." So the app sits on his own stack, and the hand-built passes go where the learning is.

| You build by hand | Then adopt | Section |
|---|---|---|
| A thin client for OpenAI's Responses API, with streaming | The AI SDK (`ai` + `@ai-sdk/openai`), behind our own interface | 01 |
| A parser: text layer with positions, OCR with confidences, tables | docling, compared side by side | 03 |
| A Postgres job queue (`SKIP LOCKED`, visibility timeout, retries) | Vercel Workflow steps | 05 |
| BM25 as one small TS function | pg_search's BM25 index | 07 |
| A durable agent runtime: checkpoints, resume, idempotent effects | Vercel Workflow | 15 |
| The agent loop and run state | Compared with the AI SDK's `WorkflowAgent`. The reference keeps ours, so every part stays visible | 16 |
| Retrieval and faithfulness metrics | Compared with autoevals' RAG scorers | 18 |

Postgres, better-auth and Cohere's reranker are adopted directly. The rate limiter (section 11) is a token bucket in Postgres that we write and keep.

## Terms

Every term is defined here once; READMEs define them again where they first appear.

| Term | Meaning |
|---|---|
| ACL | Access control list: who may read a document |
| Tenant | One customer organisation. Here: Kestrel Pay and Harbour Health |
| RLS | Row-level security: a Postgres policy that hides rows from other tenants |
| Embedding | A list of numbers that stands for a text's meaning. Similar texts get nearby vectors |
| pgvector | The Postgres extension that stores embeddings and finds nearest neighbours |
| HNSW, ANN | The graph index pgvector uses for approximate nearest-neighbour (ANN) search: much faster than checking every row, and nearly as accurate |
| BM25 | The standard keyword-ranking formula. A document scores higher when the query's words appear often in it (term frequency), when those words are rare across all documents (inverse document frequency, IDF), and it corrects for long documents (length normalisation) |
| pg_search | ParadeDB's Postgres extension that adds a BM25 index |
| RRF | Reciprocal rank fusion: merge ranked lists by giving each document `1 / (60 + rank)` from each list and summing. It uses ranks only, so BM25 and vector scores never need a common scale |
| Reranker | A model that reads the query and one candidate together and scores the match (a cross-encoder: "the librarian who opens each book"). Slower than embeddings, more accurate, so it runs on the top few dozen only |
| OCR | Optical character recognition: reading text out of an image |
| docling | IBM's open-source document converter. It turns PDF and DOCX files into structured text, with tables, OCR and page numbers |
| SSE | Server-sent events: one-way streaming from server to browser over plain HTTP |
| Durable execution | Code whose progress is saved after each step, so a crash resumes where it stopped |
| Workflow, step, hook | Vercel Workflow's terms. A workflow (`"use workflow"`) is a function replayed from its saved event log. A step (`"use step"`) is a unit of work whose result is saved, and which retries on failure. A hook pauses a workflow until something outside resumes it, such as an approval |
| Outbox | A row written in the same transaction as your data, which a relay later turns into a workflow start, so the two can't drift apart |
| Idempotency key | An id sent with a request so that a retry of it has no extra effect |
| `SKIP LOCKED` | A Postgres clause that lets several workers take different rows from a queue without waiting on each other |
| Server function, server route | TanStack Start's terms. A server function is a typed call from a component to the server. A server route is a plain HTTP handler; we use them for streams, webhooks and workflow starts |
| HyDE | Hypothetical document embeddings: embed a model-written guess at the answer, then search with that |
| recall@k, MRR, NDCG | Ranking metrics. recall@k: the share of the right chunks found in the top k. MRR: 1 divided by the rank of the first right answer, averaged. NDCG: rewards right answers near the top, scaled so a perfect ranking scores 1 |
| OpenTelemetry | The open standard for traces, metrics and logs |

## What we're building

A permissioned assistant and agent platform for **Kestrel Pay**, a fictional 600-person fintech. Employees ask questions over the company's documents and get cited answers; agents take actions with approvals; automations run on triggers.

The corpus (built in M0b, kept as is) contains the traps on purpose:

| Trap | What it tests |
|---|---|
| The Project Heron M&A memo, shared with `/Kestrel/Exec` only | Permission leaks (09) |
| Scanned and handwritten PDFs | OCR and confidence thresholds (03) |
| A table-heavy quarterly report | Table-aware chunking (04) |
| Two versions of the expenses policy | Conflicting sources (10) |
| A partner pack with hidden text telling an assistant to send the Heron memo outside | Agent safety (17) |
| Contract numbers, error codes, SKUs | Why lexical search exists (07) |
| A 3,000-page regulatory filing | Fan-out ingestion (05) |
| Harbour's expenses policy, worded like Kestrel's with different limits | Tenant isolation (09) |

A second, small tenant, **Harbour Health** (6 documents, a handful of users), exists only to prove isolation: nothing of theirs may reach a Kestrel user, and the reverse.

**fake-workspace** plays the customer's Microsoft 365. Its SharePoint-style drive has folders shared with groups, pagination, 429s with `Retry-After`, change webhooks, deletes, moves and permission changes. Its Entra-style directory lists users and nested groups. It's deterministic, so tests can trigger any edge case. better-auth handles login inside the app; the directory says who is in which group. A real GitHub connector comes later.

## Architecture

```
                         browser
                            │  httpOnly session cookie (better-auth)
      ┌─────────────────────▼──────────────────────┐
      │ app   TanStack Start on Nitro              │
      │   pages + server functions                 │
      │   server routes: chat streams, webhooks,   │
      │     workflow starts, the outbox relay      │
      │   workflows: "use workflow", "use step"    │◄──► Workflow world: files on disk
      │   src/core: parse, chunk, embed, search,   │     locally, Vercel's in the cloud
      │     rerank, ACLs, agents                   │
      └────┬────────────────┬────────────────┬─────┘
           │                │                │
     ┌─────▼──────┐   ┌─────▼──────┐   ┌─────▼────────────────────┐
     │ ParadeDB   │   │ OpenAI     │   │ fake-workspace           │
     │ Postgres 18│   │ Cohere     │   │  drive + directory       │
     │ pg_search  │   │  (rerank)  │   │ docling-serve (sect. 03) │
     │ pgvector   │   └────────────┘   │  both local only         │
     └────────────┘                    └──────────────────────────┘
```

**The state rule.** The app holds no state between requests. Product state lives in Postgres: documents, ACLs, conversations, messages, run records and the run event log. Execution state (which steps of a workflow finished, and what they returned) lives in Workflow's event log, and each run row stores its workflow run id. Steps pass ids, never large payloads, because every step's input and output is stored. Kill the dev server at any moment and nothing is lost.

## Design seams (decided)

These are where the pieces meet, and where a naive build breaks.

**Slots.** The app imports each learnable module as `#learn/<module>` (say, `#learn/search/bm25`). A small Vite plugin resolves that to `playground/<module>` when the active step declares that slot, and to `src/core/<module>` otherwise. The dev server, the workflow bundles and Vitest all resolve through it, so your code runs wherever the reference would. `ex start` writes the active step to `.ex/active-step.json`, and the plugin restarts the dev server when that file changes. Workflow replays a run's code from its event log, so a code change under a run that is still open can break the replay. So `ex start`, `ex reset` and `ex solution` cancel the open local runs before they swap files.

**Grading with a fake model.** Your prompts, tool schemas and ordering will differ from the reference, so recordings keyed by the request can't grade your code.
- Steps use the AI SDK's mock language model as a **scripted fake**: it returns scripted turns, and each test asserts only what matters about the request (the tool was offered, the context held the chunk).
- **Cassettes** store raw SSE streams, keyed by test id and call index with the body ignored. They test the hand-written client in section 01 and replay real traffic for reference evals and demos. `ex record` refreshes them.

**Streaming.** Plain chat turns (section 10) stream in-request from a server route with the AI SDK. Agent runs (from section 15) stream through the workflow's `getWritable()`: steps write tokens and step events to it, and a server route hands the run's stream to the browser, which can reconnect after a reload. Tokens never go into step results, since those are stored. The Postgres event log holds step-level events only. In section 14, before Workflow arrives, a run streams by tailing its event log from the last `seq` sent.

**Two records, one truth.** Section 14 is Postgres-only: the event log has a unique `(run_id, seq)`, runs have a `version` column for optimistic concurrency, and messages carry client idempotency keys. Section 15 adds Workflow and owns the consistency between the two records. Steps write their events with ids derived from the `stepId`, so a retried step inserts nothing twice, and any outside side effect uses the same `stepId` as its idempotency key.

**Outbox semantics (section 05).** Workflow's `start()` is a separate call, so it can't commit with our own writes.
- The write and an `outbox` row commit in one transaction. A relay, a server route that drains the outbox with `FOR UPDATE SKIP LOCKED`, calls `start()`. The request that wrote the row kicks the relay after commit; a cron run of it is the safety net.
- The relay delivers at least once, so a workflow's first step claims its outbox row by id. A duplicate start finds the row claimed and stops.
- These carry over from M0a's relay: per-key ordering (one owner per partition at a time, through a transaction-scoped advisory lock), bounded attempts before a row is marked failed and skipped, and an outage that rolls back the batch without counting attempts.
- The step also teaches the other valid shape, **workflow-first**: start the workflow, and let its first step write the row. Use the outbox when the write must commit with other data, such as a webhook receipt and its dedupe key. Use workflow-first when the workflow owns the lifecycle.
- Messages into a live conversation go through a hook whose token comes from the conversation id. Payloads carry ids, and the workflow dedupes them.

**ACLs in one database (section 09).**
- Postgres `document_acl`, joined through `group_closure`, is the **only** authorisation decision point. BM25 and vector search run in the same database, so the ACL check sits in the same SQL statement as the search.
- Any ACL copy kept next to an index for speed is a recall pre-filter only. A stale copy can over-fetch; it can never leak.
- Directory sync pulls `/users`, `/groups` and each group's direct `/members` from fake-workspace, and builds the closure itself (a member of `Finance/AP` is also in `Finance`). A test checks the result against `/transitiveMembers`.
- Login works from M0, so sections 09 and 10 use real sessions.

**The server boundary (section 11).** better-auth keeps the session in an httpOnly cookie, so the browser never holds a token.
- Every server function and server route goes through one middleware. It loads the session, takes the tenant from the session's active organisation (never from the request), and opens each transaction with `SET LOCAL app.tenant_id`, which the RLS policies read.
- A user belongs to exactly one organisation: `allowUserToCreateOrganization: false`, a `beforeAddMember` hook that refuses a second membership, and a session-create hook that sets `activeOrganizationId`.
- Streams are plain `Response`s with a `ReadableStream`. Long ones send a heartbeat every 15 seconds and stop work when the client aborts.

**Workflow in practice.**
- Workflows start from server routes. `start()` from a `createServerFn` is unverified.
- Native modules inside steps fail on Vercel with TanStack Start (workflow issue #1003). So steps use pure-JS or WASM packages, and work that needs a native module (rasterising a page for OCR, say) runs in a server route that the step calls.
- The local world (files on disk) and the Vercel world differ, so section 22 tests hooks and streams on a Vercel preview.
- **Known risk:** workflow issue #4442 breaks the dev server on nitro `3.0.260903-beta`. The fix is merged; wait for `workflow` 5.0.1 or pin. The M0 spike settles it.

## Decisions

| Area | Choice | Why | Rejected |
|---|---|---|---|
| Stack | One TanStack Start app on Nitro, from Lucien's `tanstack-starter-template` (its packages updated first): Vite 8, React 19, AI SDK 7, shadcn on Base UI, Tailwind 4, zod, pnpm | His stack, so the effort goes into the AI work | The Python backend (tagged) |
| Repo shape | A single app; learnable modules in `src/core/` | Nothing is published or deployed separately, so a monorepo adds build wiring for no gain | A pnpm monorepo |
| Template extras | Convex, Sentry, PostHog, Resend + react-email and Polar removed. Dev auth emails go to the console; seeded users are marked verified | "none of those are needed" | |
| Database | ParadeDB everywhere: `paradedb/paradedb:0.25.11-pg18` (Postgres 18.6, pg_search 0.25.11, pgvector) | BM25, vectors and the ACL decision in one database, with the same image locally and in the cloud | Neon (it retired pg_search on 21 Sep 2026, and its replacement, lakebase_text, exists only on Neon); OpenSearch |
| ORM + migrations | Drizzle: `drizzle-orm@1.0.0-rc.4` pinned exactly, `@paradedb/drizzle-paradedb@0.5.0`, the `postgres` (postgres.js) driver, drizzle-kit migrations; set up per [ParadeDB's Drizzle guide](https://www.paradedb.com/docs/start/configure-your-environment#drizzle) | ParadeDB's package pins that release candidate | Prisma |
| Lexical search | pg_search BM25, after the hand-built version in 07 | Real BM25 inside Postgres, updated in the same transaction as the rows | Postgres full-text search (not BM25); OpenSearch |
| Vector types | `vector`, `halfvec` (fp16), `bit` (binary) with rescoring; `hnsw.iterative_scan` for filtered search | pgvector's real types; iterative scan is the fix for filtered-search recall | int8 (pgvector has no int8 type) |
| Hybrid | RRF over the BM25 and vector lists | Ranks only, so no score tuning | Blending raw scores |
| Auth | better-auth 1.7.7, Drizzle adapter, organization plugin as tenants (`kestrel`, `harbour`), one organisation per user; its CLI is now `auth` (`@better-auth/cli` is deprecated) | Sessions inside the app, no identity server to run. Its adapter accepts `drizzle-orm >=1.0.0-rc.1 <2.0.0` | Keycloak + Envoy |
| Directory | fake-workspace's Graph-style `/users`, `/groups`, members and transitive members | Plays the customer's Entra ID | Keycloak |
| Durable execution | Vercel Workflow (`workflow` 5.x): steps, hooks, `sleep`, streams via `getWritable()`, `RetryableError` and `FatalError`, `stepId` for idempotency, `@ai-sdk/workflow`'s `WorkflowAgent` | Durable steps that run locally and on Vercel with no service to host | Temporal |
| Models | AI SDK 7 + `@ai-sdk/openai`, behind our interface | Lucien knows it; one API across providers | LangChain, LlamaIndex |
| Chat model | `gpt-6-luna`, the cheapest tier ($0.10 in / $0.50 out per 1M tokens); ids in one config file; reasoning effort always explicit | | |
| Embeddings | `text-embedding-3-small` (1,536 dimensions) | Its `dimensions` parameter gives the truncation exercise | |
| Reranker | Cohere `rerank-v4.0-pro` or `-fast`, through the AI SDK's `rerank()` and `@ai-sdk/cohere` | A hosted cross-encoder; OpenAI has no reranker | Self-hosting TEI or bge (section 21 covers the local path) |
| Parsing, by hand | unpdf or pdfjs-dist for the text layer with positions; tesseract.js 7 for OCR with per-word confidences (rasterise first); mammoth for DOCX | Pure JS or WASM, so they run inside workflow steps | |
| Parsing, compared | docling, through `docling-serve-cpu` in local Docker (about 4.4 GB; async API; JSON with per-item `prov[{page_no, bbox}]`) | The production converter to measure ours against | |
| Tokens | gpt-tokenizer | Pure TS, with OpenAI's encodings | |
| Tests | Vitest; the AI SDK's mock model as the scripted fake | Free, fast, repeatable | Live model calls in tests |
| Code quality | oxlint, oxfmt, tsgo | | |
| Observability | OpenTelemetry with the GenAI conventions, from section 19 (the AI SDK emits the spans); grafana/otel-lgtm locally | | Sentry |
| CI | GitHub Actions: lint, types, tests against a ParadeDB service container, the step gate | | |
| Hosting | Vercel for the app and workflows; ParadeDB self-hosted on Railway or Fly, or ParadeDB Cloud (private preview), picked at section 22 | | Neon |

**Model gotcha, carried over from poof:** the GPT-5.6 series defaults to `reasoning: "none"`. Always set reasoning effort explicitly, or agents run with reasoning off and nothing errors. `gpt-6-luna` defaults to medium; effort is still a required argument in our interface.

## Deployment profiles

| | Local (default while learning) | Cloud |
|---|---|---|
| App and workflows | `pnpm dev`; Workflow's local world | Vercel; Vercel's world |
| Postgres | ParadeDB in the repo's Compose, port 5432 | The same image on Railway or Fly, or ParadeDB Cloud (section 22) |
| fake-workspace | A Node process, port 8100 | Not deployed |
| docling-serve | Compose, port 5001, started only for section 03 | Not deployed |
| Models | OpenAI and Cohere; local models in section 21 | OpenAI and Cohere |
| Observability | grafana/otel-lgtm in Compose, from section 19 | Grafana Cloud |

## Repo layout

```
agentic-chat/
  PLAN.md  HANDOFF.md  README.md
  package.json  vite.config.ts  drizzle.config.ts  compose.yaml
  src/                       the app
    routes/                  pages and server routes (streams, webhooks, workflow starts)
    server/                  server functions, auth, the boundary middleware
    workflows/               "use workflow" and "use step" files
    components/  lib/
    core/                    the learnable modules; slots resolve here by default
      providers/  parsing/  chunking/  embeddings/
      search/                BM25 (hand-built and pg_search), vectors, RRF
      rerank/  acl/  agents/
    db/
      schema/  migrations/   Drizzle
  servers/
    fake-workspace/          Graph-style drive and directory, port 8100
  exercises/                 00.tour … 22.ship
  playground/                the active step's working copy (git-ignored)
  fixtures/
    world.yaml               tenants, people, groups, folders, sharing, facts
    corpus/sources/          the markdown sources (kept; the renderer is retired)
    corpus/build/            the built corpus, committed: manifest.json + blobs/ (about 14 MB)
    golden/                  eval questions with labelled chunks
    cassettes/               recorded model traffic
  scripts/
    ex.ts                    the step CLI; every command takes --json
    slots.ts                 the Vite plugin behind #learn/<module>
  docs/
    interview-prep/          the Spotify and Cohere prep this curriculum draws on
    m0a-contract.md  m0b-contract.md   the Python milestones' contracts, kept as history
```

## How the workshop works

Each step lives in a folder, laid out like Epic React's workshops:

```
exercises/09.acls/
  README.mdx                     section intro
  01.problem.principals/
    README.mdx                   the task, in product voice; every term defined on first use;
                                 frontmatter lists the step's type and its slots
    principals.ts                inline hints
    principals.test.ts           what "done" means
  01.solution.principals/
    principals.ts
  02.problem.over-fetch/ …
  FINISHED.mdx                   recap and what to notice
```

**Slots** (see Design seams). `ex start 09.1` copies the step's problem files, but not its tests, into `playground/`, sets the active step, and restarts the dev server. It refuses to discard playground changes to another step unless you pass `--force`. So:

- a step folder holds only the files it touches, and a slip in section 4 never blocks section 9
- the tests stay in the problem dir and import through the slot, so they grade your playground copy, and nothing you edit can change them
- the app keeps running, so you also see your code work in the app and its labs

Commands (run as `pnpm ex <command>`): `up`, `down`, `list`, `start <step>`, `test <step>`, `reset <step>`, `diff <step>`, `solution <step>`, `seed`, `record`, `gate`, `smoke`. Every command takes `--json`, so the workshop UI can shell out to `ex` later and the logic lives in one place.

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
- `lab`: done when an observable result appears in the app.

**Quality gate.** CI runs every `graded` step's tests from the problem dir, twice. Against the problem code they must fail; against the solution code they must pass. That catches a step whose tests grade nothing. A solution dir holding a `*.test.ts` fails the gate, so there is one copy of each test to trust.

**Order of work.** Exercises and their Vitest tests come first. The reference app is the lab: each section's lab is a page in the app, wired to live data. The workshop UI (step list, README and hints, a diff against the solution, a streaming test runner) comes after the exercises.

## Curriculum (107 steps)

Linear, RAG first, for three reasons:

- **Dependencies:** data flows connectors → parse → chunk → index → retrieve → answer → act, so agents get real tools that fail in real ways.
- **A Workflow ramp:** you meet Workflow on simple ingestion in 05, well before the agent runs in 15.
- **Whole system first:** the tour (00) and the always-running app show the end-to-end view before any layer is drilled.

Slots are independent, so another order is possible later if wanted.

| # | Section | Steps | You build | Lab |
|---|---|---|---|---|
| 00 | Tour | 2 | Run the app; follow one question from the route through search, rerank and the model call, then one workflow run step by step | Workflow's run viewer |
| 01 | Model primitives | 4 | Provider interface; a hand-written Responses API client with streaming; the tool-call wire format; the AI SDK behind the interface, with structured output (zod) and token counting | Request inspector |
| 02 | Connectors | 5 | Connector interface; full crawl with pagination; 429 and `Retry-After` backoff; delta sync and webhooks; deletes and moves | fake-workspace control panel |
| 03 | Parsing | 5 | Text layer vs OCR detection; OCR confidences and a review queue; tables to markdown; page mapping; docling compared | Parsed-page viewer |
| 04 | Chunking | 4 | Token-based sizing; overlap; structure-aware; table-aware | Chunks drawn over the source |
| 05 | Background work | 5 | A Postgres job queue by hand; ingestion as Workflow steps, with `RetryableError`, `FatalError` and retry limits; the outbox and relay (and workflow-first); fan-out over the 3,000-page filing; keeping a backfill from starving incremental sync | Run viewer + queue board |
| 06 | Embeddings + vectors | 5 | Batch embedding; pgvector and HNSW (`m`, `ef_search`, iterative scan); exact vs ANN recall; dimension truncation; `halfvec` and `bit` with rescoring, plus sizing | Recall vs latency chart |
| 07 | Lexical + hybrid | 5 | BM25 by hand in one small function; the pg_search index, its tokenizers and scoring; contract numbers and error codes, where BM25 beats vectors; changing a tokenizer or an embedding model without downtime; RRF | Rankings side by side |
| 08 | Rerank + query | 4 | Cohere rerank via `rerank()`, and rerank depth; query rewriting and expansion; HyDE; document-level routing | Rankings with rerank deltas |
| 09 | Identity + ACLs | 6 | Directory sync with the closure; principal cache and invalidation; ACL stamping, with Postgres as the decision point; the over-fetch filter; the ACL sync loop and the audit log; tenant isolation (see below) | User and tenant switcher |
| 10 | Generation + citations | 4 | Prompt assembly and token budget; grounding and abstention; streaming with the AI SDK; the citation validator | Prompt inspector |
| 11 | Auth + API boundary | 5 | better-auth sessions, with organisations as tenants; one middleware for every server function and route; input validation with zod, and why the tenant never comes from the client; a token bucket in Postgres; streaming through the boundary (aborts, heartbeats) | Request log |
| 12 | Frontend | 4 | Server functions in components; streaming chat with `useChat`; citation to page viewer; run timeline and approval inbox | The app itself |
| **13** | **Agents: the loop** | **6** | Tool calls by hand; a typed tool registry (zod); per-run caps and budgets; errors fed back to the model; parallel calls; per-user token budgets and a kill switch | Run stepper |
| **14** | **Agents: state** | **6** | Run state machine; the event log with `(run_id, seq)` and optimistic concurrency; rebuilding context from events; streaming step events and tokens; concurrent messages with idempotency keys; compaction and memory | Live event log |
| **15** | **Agents: durability** | **6** | Checkpoints and resume by hand, on the section 05 queue; idempotent side effects; the run as a Vercel Workflow, with the two records kept consistent; approvals as hooks that wait days; timeouts and cancellation, aborting a live model call; determinism and versioning (what a workflow function may not do, and code changes under open runs) | Kill-the-server button |
| **16** | **Agents: orchestration** | **6** | Workflows vs agents; routing; an orchestrator with sub-agents as child workflows; automations on schedules and triggers; fan-out with backpressure; the same agent with `WorkflowAgent`, compared | Run tree |
| 17 | Safety | 4 | Authorisation as the acting user; the poisoned document; plan-then-execute with an action allowlist; guardrails at the server boundary | Red-team runner |
| 18 | Evals | 5 | Golden set; recall@k, MRR and NDCG; claim decomposition; judge calibration; agent task evals in CI, compared with autoevals | Eval dashboard |
| 19 | Observability | 4 | OpenTelemetry GenAI spans; metrics and dashboards; cost per request; conversation log fan-out | Grafana |
| 20 | Debugging drills | 5 | Find the fault: stale ACLs, embedding version mismatch, rerank failing open, a poison message, the 2am schedule | Symptom dashboard |
| 21 | Air-gapped | 3 | Local models, including a local reranker; egress blocked on the network; vendored dependencies and images | Egress monitor |
| 22 | Ship it | 4 | The app and workflows to Vercel; ParadeDB in the cloud, secrets and migrations; hooks and streams tested on a Vercel preview; CI/CD | |

**09.6, tenant isolation.** RLS needs the app on a non-owner role, since a table owner bypasses RLS unless it is forced. The tenant is set per transaction with `SET LOCAL`, and background jobs that cross tenants get their own explicit role. The app role needs SELECT on `acl_version_seq` to read the audit's high-water mark, since USAGE alone is refused. Rate limits and budgets are per tenant.

**21, the local reranker.** It uses transformers.js, called directly: `AutoModelForSequenceClassification`, then a sigmoid over the logit. Never the pipeline API, which scores every document 1.0.

Section 20 is practice for the debugging-round format: each drill ships a broken system and a symptom, and you find the cause.

## Build plan

Exercises are carved out of a working app. The agent reference is written **before** any exercises, so the run and event schema settles before dozens of steps depend on it.

| Milestone | Delivers | Done when |
|---|---|---|
| **M0 Foundations** | The template, stripped of Convex and the extras; the Python tree removed (it lives on in the tags); Drizzle + ParadeDB with the schema; better-auth with organisations; seeding from `world.yaml`; corpus and world kept; fake-workspace ported, with its directory; the Workflow spike; the `ex` CLI, slots and the gate; CI | `ex smoke` passes: `leo.martin` logs in and sees `kestrel`; fake-workspace shows the Heron memo shared with `/Kestrel/Exec` only; a pg_search BM25 query and a pgvector query run; the spike workflow survives a hook resume and a sleep; the gate passes on one sample step (see the appendix) |
| **M1 Reference: RAG** | The finished implementation behind sections 01 to 12, plus the golden set | A question is answered end to end, cited, with ACLs enforced, and the Heron memo never reaches the intern (`leo.martin`) |
| **M2 Reference: agents** | The runtime behind 13 to 17 | A run survives a killed dev server mid-tool-call with the side effect happening once; an approval resumes a paused run |
| **M3 Exercises 00 to 12** | Steps, tests, READMEs, labs | The quality gate passes for every graded step |
| **M4 Exercises 13 to 17** | Steps, tests, READMEs, labs | The quality gate passes |
| **M5 The rest** | Evals, observability, drills, air-gapped, ship; the workshop UI | The quality gate passes for all graded steps |

## To verify while scaffolding

These may change details. None of them changes the architecture.

- **Workflow #4442:** which `workflow` release carries the fix (5.0.1?), or which nitro and workflow pins work together until then. The spike decides.
- **`start()` from a server function:** does it work from a `createServerFn`? Until verified, every start goes through a server route.
- **The ORM trio:** `drizzle-orm@1.0.0-rc.4`, better-auth 1.7.7's Drizzle adapter and `@paradedb/drizzle-paradedb@0.5.0`, together on ParadeDB: migrations, uuid ids for the auth tables, and `auth.api.createUser` and `addMember` called with no headers.
- **docling-serve:** the exact `docling-serve-cpu` image tag, pinned.
- **Cohere:** the rerank model id (`rerank-v4.0-pro` or `rerank-v4.0-fast`) as `@ai-sdk/cohere` takes it.
- **Slots and Workflow:** whether Workflow bundles workflows and steps through Vite. If it doesn't, the same resolver goes in as an esbuild plugin.
- **Testing waits:** how to test hooks and sleeps without waiting for real (a test world, a clock, or our own fake). Section 15 is graded on this.
- Pin the exact version of every image and package.

## Appendix: M0 spec

Enough for a fresh agent to start without guessing. `docs/m0b-contract.md` still holds where it describes behaviour (the schema rules, fake-workspace's API); this appendix says what changes for TypeScript.

**Services and local ports.** All bind to 127.0.0.1.

| Service | Port | How it runs |
|---|---|---|
| app (TanStack Start dev server, with Workflow's local world) | 3000 | `pnpm dev` |
| fake-workspace | 8100 | `pnpm fake-workspace` (a Node process that restarts on change) |
| ParadeDB, `paradedb/paradedb:0.25.11-pg18` | 5432 | `compose.yaml`; the dev role and password live there and in `.env.example` |
| docling-serve (`docling-serve-cpu`) | 5001 | `compose.yaml`, behind a profile, so it starts only for section 03 |

`ex up` starts Compose and refuses to start if a process outside Docker holds 5432.

**Schema** (ported from M0b's migration `0002`; the rules in `docs/m0b-contract.md` "Schema" and "Settled during the build" carry over):
- **Auth** (better-auth, generated by the `auth` CLI, ids as uuids): `user`, `session`, `account`, `verification`, `organization` (the tenants), `member`, `invitation`. The app reaches these only through better-auth, so they have no RLS.
- **Every app table** has `tenant_id` referencing `organization(id)`, with RLS enabled and the same policy (forced from section 09). Child tables reference parents through **composite tenant FKs**, `(tenant_id, parent_id) → parent(tenant_id, id)`, so a row can't point into another tenant.
- **Identity:** `principals` (users and groups mirrored from the directory; unique `(tenant_id, kind, external_id)`), `group_members` (direct only), `group_closure` (computed; no self rows, so depth starts at 1; member index `(member_id, group_id) INCLUDE (tenant_id)`; a cycle must be skipped).
- **Content:** `documents` (source, external_id, version, content_hash, status, valid_from/valid_to, acl_version), `document_acl` (principal, allow/deny, acl_version), `chunks` (document, version, ordinal, text, page_start and page_end both set or both null, section, token count, `embedding vector(1536)`, embedding_model_version). No HNSW or BM25 index yet: sections 06 and 07 build them.
- **`acl_version_seq`:** one global sequence, cache 1. Every ACL change on a document takes `nextval`, and its `document_acl` rows carry the same value, so the values order ACL changes across all documents. Group-membership and `enabled` changes don't advance it.
- **Sync and ingest:** `sync_state` (connector cursor or delta token), `outbox` (id, kind, payload, partition_key, created_at, published_at, attempts, last_error, failed_at).
- **Conversation:** `conversations`, `messages` (unique `(conversation_id, seq)` and `(conversation_id, idempotency_key)`; `content` must be a JSON object or array).
- **Audit:** `retrieval_audit` (user, query hash, returned ids, denied ids, acl_version, created_at). Its `acl_version` is the sequence's high-water mark, read **after** the retrieval query in the same transaction (or anywhere inside one REPEATABLE READ snapshot). Read before it under READ COMMITTED, the stale-ACL drill would excuse a real leak.
- **Not in M0:** `runs`, `run_events`, `approvals`. The agent reference (M2) settles them.
- A raw SQL update or upsert sets `updated_at` itself; Drizzle's `$onUpdate` runs only through the ORM. A drift test fails when the TS schema and the migrations disagree.

**Auth and seeding.** `ex seed` reads `world.yaml` and, for each tenant, creates the organisation, then each user with `auth.api.createUser` (email `username@domain`, the tenant's dev password, verified) and `addMember`, with no request headers. It is idempotent. Directory principals aren't seeded: section 09's sync builds them from fake-workspace. In dev, verification and reset emails print to the console.

**fake-workspace** (`servers/fake-workspace/`, a TS port of the Python service). Its behaviour is `docs/m0b-contract.md` "fake-workspace" plus "Settled during the build": the Graph-style site API, delta with 410 `resyncRequired`, subscriptions and webhooks, the dev-only control API, keyset paging, eTags that change with effective sharing, and subscription ids that are never reused. Port its tests along with it. New here, the directory, scoped by the same bearer tokens (`dev-workspace-kestrel`, `dev-workspace-harbour`):
- `GET /v1.0/users`: `id` (the world's id), `userPrincipalName`, `displayName`, `jobTitle`, `accountEnabled`
- `GET /v1.0/groups`: `id`, `displayName` (the group's path)
- `GET /v1.0/groups/{id}/members` (direct) and `GET /v1.0/groups/{id}/transitiveMembers` (nested)
- all paged with `$top` and `@odata.nextLink`

**Corpus.**
- `fixtures/corpus/build/` is committed as built by `python-m0b` (manifest sha256 `8b610412…`): `manifest.json` plus 46 content-addressed blobs, about 14 MB. M0 takes it out of `.gitignore` and drops `inputs.json`, which only the renderer used.
- Kestrel has 40 documents: 20 pdf, 7 docx, 6 md, 3 handwriting, 2 scan, 1 pdf_mixed, and the 3,000-page generated filing. Harbour has 6: 4 pdf, 1 docx, 1 md.
- The Python renderer is retired. The sources stay as the readable truth, and `fixtures/corpus/README.md` keeps the trap table. To change a document, re-render it from the `python-m0b` tag.
- A TS test over the built files keeps M0b's main lesson: every identifier is whole in each PDF's text layer, and each trap still holds in the built file (the source can be right while the PDF is wrong).
- `world.yaml` is unchanged. Ids are `uuid5(id_namespace, "<tenant>:<kind>:<name>")`, so the manifest, fake-workspace and the database agree without a lookup table.

**Provider interface (sketch)**

```ts
type Reasoning = { effort: ReasoningEffort }  // the provider's levels; required, never defaulted

interface ChatModel {
  respond(input: ChatInput, opts: { tools?: ToolSet; reasoning: Reasoning; signal?: AbortSignal }): Promise<ChatResponse>
  stream(input: ChatInput, opts: { tools?: ToolSet; reasoning: Reasoning; signal?: AbortSignal }): AsyncIterable<ChatEvent>
}
interface EmbeddingModel {
  embed(texts: string[], opts?: { dimensions?: number }): Promise<number[][]>
}
interface Reranker {
  rerank(query: string, docs: string[], opts: { topN: number }): Promise<{ index: number; score: number }[]>
}
```

Implementations: the hand-written client (section 01), the AI SDK, the AI SDK's mock model (tests), cassettes, and local models (section 21).

**`ex smoke`** checks that:
1. ParadeDB answers, with `pg_search` and `vector` at the pinned versions, and every app table has RLS enabled with its policy.
2. `leo.martin` signs in with the Kestrel dev password, and the session's active organisation is `kestrel`.
3. As Kestrel's connector, fake-workspace pages the root with `$top=2` through `nextLink`. The Heron memo's permissions grant exactly one thing, `write` to `/Kestrel/Exec`, matched by the world's group id and its path. Harbour's token on Kestrel's site gets 403.
4. The directory returns `leo.martin` and `/Kestrel/Finance/AP` with the ids `world.yaml` implies, and `/Kestrel`'s transitive members include `leo.martin`.
5. A pg_search BM25 query for `KPC-2026-0142` ranks the matching row first, and a pgvector nearest-neighbour query returns the expected row.
6. The spike workflow, started from a server route, waits on a hook, is resumed, sleeps, streams a few chunks through `getWritable()`, and completes.
7. The gate passes on one sample step: its tests fail against the problem and pass against the solution.

## Unresolved questions

None. The open items are facts to check while scaffolding (above), and none of them needs a choice from Lucien.
