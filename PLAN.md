# agentic-chat: plan

A hands-on workshop for building a production-shaped AI application: a small version of Cohere's North. You build every layer yourself, one step at a time, against a finished reference app that runs the whole way through.

Status: **planning** (agreed 2026-09-30). Nothing scaffolded yet.

## Why this exists

Cohere turned Lucien down after the onsite (22 Sep 2026). From Cate Ciugureanu's email:

> "Your ability to architect a clean distributed system with webhooks, queues, and background workers showed strong practical execution skills. While your system design and execution skills were strong, we observed opportunities to deepen your expertise in autonomous agent orchestration and state management."

So retrieval is covered properly, and agents (sections 13 to 17) get the most steps. By the end you will have built by hand:

- an agent run stored as a state machine plus an append-only event log
- a run that crashes mid-tool-call and resumes without repeating a side effect
- a run that waits days on a human approval, then carries on
- a conversation that receives two messages at once and stays consistent
- context rebuilt from stored state each turn, and compacted when it grows

## What we're building

A permissioned assistant and agent platform for **Kestrel Pay**, a fictional 600-person fintech. Employees ask questions over the company's documents and get cited answers; agents take actions with approvals; automations run on triggers.

The seeded corpus contains the traps on purpose:

| Trap | What it tests |
|---|---|
| An M&A memo only execs can see | Permission leaks (section 09) |
| Scanned and handwritten PDFs | The OCR path and confidence thresholds (03) |
| A table-heavy quarterly report | Table-aware chunking (04) |
| Two versions of the expenses policy | Conflicting sources (10) |
| A document carrying a prompt injection | Agent safety (17) |
| Contract numbers, error codes, SKUs | Why BM25 exists (07) |
| A 3,000-page regulatory filing | The big-document splitter (05) |

**fake-workspace** stands in for the customer's Microsoft 365: a directory (users, nested groups, roles) and a drive (folders shared with groups, pagination, 429s with `Retry-After`, change webhooks, deletes, moves, permission changes). It's deterministic, and tests can trigger any edge case on demand. A real GitHub connector comes later.

## Architecture

```
                 browser
                    │
        ┌───────────▼────────────┐
        │ web (TanStack Start)   │   Vercel in the cloud profile
        └───────────┬────────────┘
                    │ HTTPS + SSE
        ┌───────────▼────────────┐
        │ gateway (Envoy)        │   JWT via JWKS, rate limits, routing,
        └──┬──────────────┬──────┘   timeouts, request ids
           │              │
  ┌────────▼─────┐  ┌─────▼──────┐
  │ api (Hono)   │  │ auth       │   better-auth, issues JWTs
  │  chat        │  └────────────┘
  │  retrieval   │
  │  runs        │── starts runs, streams their events to clients
  │  admin       │
  └──────┬───────┘
         │ pg-boss jobs (enqueued in the same transaction as the write)
  ┌──────▼───────────────────────────────────────────┐
  │ workers                                          │
  │  sync         crawl, delta sync, webhooks, ACLs  │
  │  ingest       split, parse, OCR, chunk, embed    │
  │  agents       execute runs step by step          │
  │  automations  cron and webhook triggers          │
  └──────────────────────────────────────────────────┘

  postgres + pgvector · redis · minio · jaeger · fake-workspace
  temporal (section 15) · local models (section 21)
```

**The state-management rule the whole design follows:** the api is stateless. Agent runs execute in workers. Every piece of run state lives in Postgres, and a client follows a run by tailing its event log (LISTEN/NOTIFY). Kill any process at any moment and nothing is lost.

## Decisions

| Area | Choice | Why | Rejected |
|---|---|---|---|
| Language | TypeScript, Node 22, pnpm workspaces | Matches Lucien's other repos | Python: better ML libraries, but the goal is systems and agents |
| Topology | Separate web, gateway, api, auth, workers | How production apps are built. No shortcuts | One TanStack Start app for web and API |
| Frontend | TanStack Start + Router + Query, shadcn (Base UI), Tailwind | Lucien's stack | |
| Gateway | A toy gateway in Hono as an exercise; Envoy in the running stack | Build one to understand it, then configure the real thing | Managed gateways, which can't be self-hosted |
| API | Hono | Small, fast, runs anywhere | |
| Auth | better-auth issuing JWTs, verified at Envoy against JWKS | Real authentication at the edge | |
| Database | Postgres + pgvector: the pgvector image locally, Neon in the cloud | Same behaviour everywhere; ACL filters are plain SQL | ParadeDB, because Neon removed pg_search on 21 Sep 2026 |
| BM25 | Our own, on Postgres tables | Portable. The section 07 exercise becomes the real implementation | pg_search and Neon's lakebase_text are host-specific |
| ORM | Drizzle | Native `vector` column; raw SQL is normal | Prisma: vector columns stay `Unsupported("vector")`, so vector queries go raw |
| Queue | pg-boss | Lives in Postgres, so a row and its job commit together | BullMQ, which needs Redis as the queue |
| Cache + rate limits | Redis (Valkey) | Envoy's global rate limit service, principal cache, embedding cache | |
| Files | MinIO locally; Vercel Blob or S3 in the cloud | S3 API, self-hostable | |
| Models | OpenAI Responses API | Lucien's choice | Cohere, local-only |
| Chat model | `gpt-5.6-luna` by default, ids in one config file | Cheapest GPT-5.6 tier, as used in poof | |
| Embeddings | `text-embedding-3-small` | Its `dimensions` parameter gives the truncation exercise | |
| Reranker | An open cross-encoder (bge-reranker) that we run | OpenAI has none | Hosted rerank APIs (allowed as a cloud option) |
| Parsing | unpdf, tesseract.js, mammoth | Text layer, OCR and docx, all in Node | docling (Python) |
| Durable runs | Hand-built on Postgres, then ported to Temporal | Build it first, then see what a tool gives you | Agent frameworks; OpenAI Agents API; Vercel Workflow as the main path |
| Tracing | OpenTelemetry to Jaeger, plus the run event log | The event log doubles as the LLM trace | |
| Tests | Vitest against a fake model that replays recorded responses | Free, fast, repeatable | Live API calls in tests |
| Tooling | oxlint, oxfmt, tsgo, zod | Same as Lucien's templates | |

**Left out on purpose:** LangChain, LangGraph, Mastra, the OpenAI Agents SDK and Agents API, and any SDK helper that runs the tool loop for you. They hide the part this repo exists to teach. Convex is out for the same reason.

**Model gotcha, carried over from poof:** the GPT-5.6 series defaults to `reasoning: "none"`. Always set reasoning effort explicitly, or agents run with reasoning off and nothing errors.

## Deployment profiles

The same code runs two ways. Seeing both is part of the lesson.

| | Local / on-prem (default while learning) | Cloud |
|---|---|---|
| web | TanStack Start dev server | Vercel |
| gateway, api, auth, workers | Docker Compose | A container host (Railway or Fly) |
| Postgres | pgvector image | Neon (direct connection for workers, pooled for api) |
| Files | MinIO | Vercel Blob or S3 |
| Rate limits + cache | Redis container | Upstash or the host's Redis |
| Reranker | In-process or a local container | On the container host, or a hosted rerank API |
| Models | OpenAI; local models in section 21 | OpenAI |

OCR is CPU-heavy and only ever runs on workers, never inside a request.

## Repo layout

```
agentic-chat/
  PLAN.md  README.md
  apps/
    web/             TanStack Start: chat, citations, run timeline, approvals, admin
    api/             Hono: chat, retrieval, runs, admin
    auth/            better-auth
    workers/         pg-boss workers: sync, ingest, agents, automations
    fake-workspace/  directory + drive stand-in
    workshop/        TanStack Start, local only: steps, diffs, tests, labs
  packages/
    db/              Drizzle schema and migrations
    models/          provider interface, OpenAI client, fake, local
    ingest/          connectors, parsers, chunkers
    retrieval/       BM25, dense search, RRF, rerank, ACL filter, query rewriting
    agents/          loop, tool registry, run store, runtime
    identity/        directory sync, principal resolution
    evals/           metrics, judges, runner
    shared/          types, zod schemas, config
  exercises/
    00.tour/ … 22.ship/
  fixtures/
    corpus/          Kestrel's documents, traps included
    directory/       users, nested groups, roles
    golden/          eval questions with labelled chunks
    recordings/      recorded model responses for tests
  infra/
    compose.yaml  envoy/  temporal/
  scripts/
    ex.ts            step CLI, shared with the workshop app
```

## How the workshop works

Each step lives in a folder, laid out like Epic React's workshops:

```
exercises/09.acls/
  README.mdx                     section intro
  01.problem.principals/
    README.mdx                   the task, in product voice
    principals.ts                inline hints
    principals.test.ts           what "done" means
  01.solution.principals/
  02.problem.over-fetch/ …
  FINISHED.mdx                   recap and what to notice
```

**Slots.** The finished app imports each learnable piece through a slot. By default a slot points at the reference implementation. `pnpm ex start 09.2` copies that step's problem files into `playground/09.2/`, points its slots there, and restarts the affected services. So:

- a step folder holds only the files it touches, and a slip in section 4 never blocks section 9
- the tests import through the slot, so they grade your playground copy
- the whole stack keeps running, so you also see your code work in the app, the traces and the labs

Other commands: `pnpm ex reset 09.2`, `pnpm ex diff 09.2` (you against the solution), `pnpm ex solution 09.2`, `pnpm ex list`.

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

**The workshop app** (`apps/workshop`, local only) shows the step list with progress, the README and hints, your files with a diff against the solution, a test runner that streams results, an "open in editor" link, and a **lab panel** for the section, wired to the running stack.

**The fake model.** Tests run with `MODEL_PROVIDER=fake`, which replays recorded OpenAI responses keyed by a hash of the request. `pnpm record` refreshes the recordings against the real API. The live app uses OpenAI.

**Quality gate.** A check runs every step both ways: the problem's tests must fail, and the solution's tests must pass. That catches a step whose tests grade nothing.

## Curriculum (about 99 steps)

| # | Section | Steps | You build | Lab |
|---|---|---|---|---|
| 00 | Tour | 2 | Run the stack; follow one question through every service in Jaeger | Trace viewer |
| 01 | Model primitives | 4 | Provider interface; Responses API client with streaming; the tool-call wire format; structured output and token counting | Request inspector |
| 02 | Connectors | 5 | Connector interface; full crawl with pagination; 429 and `Retry-After` backoff; delta sync and webhooks; deletes and moves | fake-workspace control panel |
| 03 | Parsing | 4 | Text layer vs OCR detection; handwriting confidence and a review queue; tables to markdown; page mapping | Parsed-page viewer |
| 04 | Chunking | 4 | Token-based sizing; overlap; structure-aware; table-aware | Chunks drawn over the source |
| 05 | Workers | 5 | Idempotency keys; retries and dead letters; the big-document splitter; incremental over backfill; progress | Queue board |
| 06 | Embeddings + vectors | 5 | Batch embedding; pgvector and HNSW (M, ef_search); exact vs ANN recall; dimension truncation; int8 and binary with rescoring, plus sizing | Recall vs latency chart |
| 07 | Lexical + hybrid | 3 | BM25 on Postgres tables; RRF; the hybrid query | Rankings side by side |
| 08 | Rerank + query | 4 | Cross-encoder rerank and depth; query rewriting and expansion; HyDE; document-level routing | Rankings with rerank deltas |
| 09 | Identity + ACLs | 5 | Directory sync with nested groups; principal cache and invalidation; ACL stamping; the over-fetch filter; ACL sync loop and audit log | User switcher |
| 10 | Generation + citations | 4 | Prompt assembly and token budget; grounding and abstention; SSE streaming; the citation validator | Prompt inspector |
| 11 | Auth + gateway | 5 | better-auth JWTs and JWKS; a toy gateway (verify, route, request ids); a token bucket on Redis; Envoy config; SSE through Envoy | Request log |
| 12 | Frontend | 4 | Streaming chat; citation to page viewer; run timeline; approval inbox | The app itself |
| **13** | **Agents: the loop** | **5** | Tool calls by hand; a typed tool registry (zod); caps and budgets; errors fed back to the model; parallel calls | Run stepper |
| **14** | **Agents: state** | **6** | Run state machine; event log; rebuilding context from events; streaming events to clients; concurrent messages; compaction and memory | Live event log |
| **15** | **Agents: durability** | **6** | Crash and resume; checkpoints; idempotent side effects; cancellation and timeouts; approvals that wait days; port to Temporal | Kill-the-worker button |
| **16** | **Agents: orchestration** | **5** | Workflows vs agents; routing; an orchestrator with sub-agents; automations on triggers; fan-out with backpressure | Run tree |
| 17 | Safety | 4 | Authorisation as the acting user; the poisoned document; plan-then-execute with an action allowlist; guardrails at the gateway | Red-team runner |
| 18 | Evals | 5 | Golden set; recall@k, MRR and NDCG; claim decomposition; judge calibration; agent task evals in CI | Eval dashboard |
| 19 | Observability | 3 | Per-stage spans; cost per request; conversation log fan-out | Trace and cost view |
| 20 | Debugging drills | 5 | Find the fault: stale ACLs, embedding version mismatch, rerank failing open, a poison message, the 2am cron | Symptom dashboard |
| 21 | Air-gapped | 3 | Local models; egress blocked on the network; vendored dependencies | Egress monitor |
| 22 | Ship it | 3 | web to Vercel; backend to a container host; Neon, Blob, secrets, migrations | |

Section 20 is practice for the debugging-round format: each drill ships a broken system and a symptom, and you find the cause.

## Build plan

Exercises are carved out of a working app, so the reference comes first.

| Milestone | Delivers | Done when |
|---|---|---|
| **M0 Skeleton** | Monorepo, Compose (postgres, redis, minio, jaeger, envoy), fake-workspace, fixtures (corpus + directory), db schema, models package with the fake provider, the `ex` CLI and slots, the workshop app shell | `pnpm dev` brings everything up and a smoke test passes |
| **M1 Reference, RAG path** | The finished implementation behind sections 01 to 12, plus the golden set | A question is answered end to end, cited, with ACLs enforced, and the M&A memo never reaches the intern |
| **M2 Exercises 00 to 12** | Steps, tests, READMEs and labs for those sections | The quality gate passes for every step |
| **M3 Agents** | Reference runtime for 13 to 17, then their steps and labs | A run survives a killed worker mid-tool-call, and an approval resumes a paused run |
| **M4 The rest** | Evals, observability, drills, air-gapped, ship | The quality gate passes for all steps |

## To verify while scaffolding

- Current OpenAI model ids and prices; confirm `gpt-5.6-luna` and set reasoning effort explicitly
- Which reranker runtime works well on Apple silicon: transformers.js in-process, or a TEI container
- tesseract.js quality on the handwritten fixtures (the handwriting will be synthetic: a handwriting font, rasterised with noise)
- Envoy stream idle timeouts for long SSE connections
- pg-boss and LISTEN/NOTIFY through Neon: workers use a direct connection, never the pooler
- Temporal's local dev server inside Compose
