# Handoff: agentic-chat

For the next agent picking this up. Read this first, then `PLAN.md` (the source of truth for what to build). This file is the history: how the project came about, what Lucien said at each decision, how he learns, and the traps in this environment.

## TL;DR

- **What:** a hands-on workshop repo where Lucien builds a production-grade AI application (a small Cohere North) layer by layer, Epic React style: problem and solution folders, hints inline, tests as the grader, run from a local workshop web app with a lab panel per section.
- **Why:** Cohere rejected him after the onsite. The feedback named one gap: "autonomous agent orchestration and state management."
- **State:** M0a (infra + tooling) is done and merged to `main`; `ex up` then `ex smoke` pass. The next step is milestone M0b (schema, fixtures, fake-workspace) in `PLAN.md`.
- **Repo:** `~/src/luciengeorge/agentic-chat` (local git, no remote).

## Who Lucien is

- Full-stack TypeScript engineer at Fyxer (Firebase functions, Firestore, Cloud Tasks, GrowthBook). Personal repos live in `~/src/luciengeorge/`, among them `poof` (an autonomous trading agent on Convex and Vercel), `tanstack-starter-template` and `vite-interview-template`.
- Usual stack: pnpm, Vite, React, TanStack Router, Query and Start, shadcn on Base UI, Tailwind, zod, Vitest (sometimes browser mode), oxlint, oxfmt, tsgo, msw. He chose a **Python backend** for this repo on purpose: it's what AI backends mostly use.
- He had never built a production agent app. His own read of the rejection: "maybe lack of prep, but 2 is that i don't have enough hands on experience in a fully fledged out production application involving agent orchestration."

### How he learns (observed across four mock interviews and a self-check)

- **Recognises correct answers instantly, and struggles to produce them cold.** The biggest pattern by far.
- **States the fact and stops before the mechanism.** "It adds latency" without "because the traversal visits more nodes." On an 11-question self-check he scored about 6.5 of 11, almost every lost half-point this shape.
- **Hands the question back when stuck** ("walk me through it", "give me the answer"): six times in one mock. He says "I don't know" without then reasoning out loud.
- **Asks for plain language and dislikes unexplained acronyms.** Direct quote: "You're using too many acronyms without explaining them to me. assume i have little knowledge in building AI pipelines."
- **Learns well from worked examples with real numbers.** The ones that landed: recall@k with 2 of 3 chunks, NDCG built up from its name, index size from `chunks × dims × bytes`, cross-encoders explained as "the librarian who opens each book".

**What this means for the exercises:**
- Define every term the first time it appears in a README.
- Hints should push for the *why* (🦉), and tests should check behaviour that only the mechanism explains.
- Labs should make effects visible: rankings side by side, denied chunks, a run resuming after the worker is killed.

### Preferences and instructions

- `~/.claude/CLAUDE.md`, which is binding. In short:
  - Be extremely concise.
  - The main model plans and judges. Code goes to Agent subagents with `model: 'opus'`, never to GPT or Codex (Codex is for read-only review only).
  - Reviews go to a fresh agent that didn't do the work.
  - Only add comments where the code needs clarification.
  - End every plan with concise unresolved questions.
  - Record work in the Obsidian vault.
- `~/obsidian/AGENTS.md`: the daily note `daily/YYYY-MM-DD.md` gets a timestamped bullet for every change (the #1 rule). Project hubs live at `projects/<slug>/index.md`. Commit after writing, one commit per meaningful change.
- House writing style for anything he reads: plain words, no em dashes, varied sentence length, and none of the "not X, but Y" construction.
- On scope, twice and firmly: **no shortcuts.** "this is about learning the best practices out there for a production grade AI application."

## History

### 1. Spotify system design prep (about 11 to 17 Sep 2026)

- **The brief:** a recruiter asked him to design a simplified Spotify (search, playback, publisher uploads) for about 1M users in a startup context.
- **What I wrote for him:** a study guide, a 60-minute spine, a cheat sheet and four mermaid diagrams, now in `docs/interview-prep/spotify/`.
- **What he asked about along the way:** DAU/MAU ratios, what an upload SLA is, bitrates, codecs, HLS and ABR, QPS and peak factors, SLOs, S3 storage tiers, CDNs, Kafka versus Sidekiq, and what a gateway is.
- **Two mocks (interviewer "Maya").** Problems in the first:
  - a peak-QPS error (13,650 instead of about 1,400)
  - jumped to solutions during scoping
  - listed components instead of narrating a flow
  - couldn't reconstruct the upload flow
  - shallow failure handling
- **The second mock** was cleaner: good capacity numbers, and he separated CDN from origin egress. He still needed teaching on failure handling, where I introduced a four-question framework and three idempotency patterns.
- **The Spotify interview's outcome was never discussed.**

### 2. Cohere prep (about 13 to 19 Sep 2026)

- **Brief (Cohere's onsite PDF, marked confidential, so not copied here):**
  - One 60-minute round on Google Meet: introduction 5 to 10 minutes, design exercise 30 to 35, Q&A 5 to 10.
  - Excalidraw is suggested for drawing.
  - Their tips: clarify the problem, think holistically, discuss trade-offs, keep it practical, communicate clearly, look ahead, and "study how a system similar to North is designed."
- **Research:** North, Compass, Command A+ (May 2026: 218B-parameter MoE with 25B active, runs on 2×H100 at 4-bit), Embed v4 (Matryoshka dimensions 256 to 1536, 128K context, multimodal), Model Vault, deployment options, and the enterprise RAG permission model.
- **Materials,** now in `docs/interview-prep/cohere/`:
  - a North primer and RAG fundamentals (with an acronym glossary and a self-check with model answers)
  - the interview spine and practice questions Q1 to Q9 (enterprise RAG, agent platform, ingestion, permission-aware search, private inference, workflow automation, conversation-log ingestion, LLM code review, evals and guardrails)
  - diagrams, a debugging-round guide, and model answers for Q1 and for a pharma air-gapped scenario
- **Topics he asked me to explain.** These show where his knowledge was thin: ACL, VPC, embedding dimension, recall@k, quantisation, HNSW graph overhead and the M parameter, Matryoshka, long-context embedding versus chunking, Compass's role, two-stage retrieval and cross-encoders, ANN, RRF, BM25, what a gateway is and whether frameworks provide one, why 4 bytes per float, index sizing, embedding-throughput assumptions, CPU versus GPU, dual-index cutover, golden-set evals, NDCG, measuring retrieval versus generation, chunk sizing, sharding, citation validation, table chunking, failure points, and how to answer "it's hallucinating."
- **Mock "Priya"** (financial-services Q1):
  - Strong: scoping (he asked where it deploys), sizing, and he found the OCR bottleneck himself.
  - Weak: handed back six questions, confused pre-filtering with post-filtering, never drew the perimeter box, skipped the failure-modes question twice, and spent 16 of 30 minutes on sizing.
- **Mock "Tom"** (pharma, air-gapped):
  - Improved: explained mechanisms, asked for the page-size distribution.
  - Regressed: never asked where it deploys despite an explicit hint, again no perimeter, answered one of two questions twice, dropped the stated citation requirement, 15 minutes before drawing anything, and said "I don't know" without reasoning.
- **Researched reported Cohere topics:** a distributed-systems debugging round, multi-tenant inference, conversation-log ETL, RAG, evals and guardrails; in coding rounds, rate limiters, streaming parsers and request batchers.
- **Vault:** extended `topics/building-with-llms/` with permission-aware retrieval, index sizing, ingestion economics, ranking metrics, prompt injection as an architecture problem, and a new deployment-and-sovereignty note. Commit `4c29d42`, 18 Sep.

### 3. The outcome (22 Sep 2026)

From Cate Ciugureanu, Talent Partner:

> "Your ability to architect a clean distributed system with webhooks, queues, and background workers showed strong practical execution skills. While your system design and execution skills were strong, we observed opportunities to deepen your expertise in autonomous agent orchestration and state management."

The exact question he got in the onsite was never shared.

### 4. Planning agentic-chat (30 Sep 2026)

The plan went through several revisions in one sitting. Here is each decision, with his words:

| # | Topic | What Lucien said | Result |
|---|---|---|---|
| 1 | The ask | "help me build a repo that will guide me through how to build such an app. it should be very interactive. Similar to how https://github.com/luciengeorge/react-suspense ... is structured, with exercises well commented and solutions files" | His react-suspense repo is private (404), so the public `epicweb-dev/react-suspense` was used as the format reference |
| 2 | Scope | Listed file ingestion, tool calling, querying, BM25, reranking, query expansion, workers, gateway, frontend, database, connectors, parsing, chunking, ACLs, embeddings, vector store, "and anything else I might have missed" | All in the curriculum. Added: durable execution, state, human-in-the-loop, memory, evals, observability, safety, debugging drills, air-gapped, deploy |
| 3 | Location | Asked for `~/lucien/luciengeorge/` | That path doesn't exist; used `~/src/luciengeorge/` where his other repos are. Not objected to |
| 4 | Format | "It doesn't need to be the exact same run. I think it should run as a web app but you decide" | A custom TanStack Start workshop app with lab panels. Epic Workshop's app would need a full app copy per step |
| 5 | Models | OpenAI | Responses API, `gpt-5.6-luna` by default, `text-embedding-3-small`. OpenAI has no reranker, so we self-host one |
| 6 | Order | RAG first, then agents | Milestones M1 and M2 cover RAG; M3 covers agents |
| 7 | Name | "agentic-chat" | |
| 8 | Stack questions | "maybe we can use tanstack start as a fullstack framework. what's best for workers when using tanstack start? also why paradedb instead of prisma for example? and maybe vercel for hosting" | Explained ORM versus database. Found that **Neon removed pg_search on 21 Sep 2026**, so ParadeDB was dropped. Vercel became the cloud target for web |
| 9 | ORM | "There is a pgvector extension we can enable with prisma but fine with drizzle too" | Drizzle, later replaced by SQLAlchemy when Python was chosen |
| 10 | Topology | "Actually happy to have a separate frontend and backend and make use of a gateway. I feel like most production app work this way and i dont want to take any shortcuts" | Separate web, Envoy, api, workers. I had wrongly folded web and API together to save moving parts |
| 11 | API framework | "why hono for the api?", then "what is usually used for these types of applications", then chose **Python + FastAPI** | Python backend; web and workshop stay TypeScript; types cross via OpenAPI |
| 12 | The rule | "like I said i dont want to take any shortcuts. this is about learning the best practices out there for a production grade AI application" | Production tools only, each built by hand first. Temporal for all background work, a transactional outbox, OpenSearch, Keycloak, docling, TEI, Grafana |
| 13 | Cloud backend | Container platform (not Kubernetes) | Fly or Railway, running the same images as Compose |
| 14 | Hardware | Mac with 32 GB or more | The full stack runs at once |
| 15 | Handoff | "make sure the plan.MD or another file that you generate contains the whole history of our conversation as well. I'd like to pass this off to another agent" | This file |
| 16 | Review | Asked to "review the plan" | A fresh agent reviewed it; all 15 findings accepted (next section) |
| 17 | Multi-tenancy | In scope, one step | 09.6; `tenant_id` + RLS from the first migration; a second tenant (Harbour Health) to prove isolation |
| 18 | Learner path | "regardless of cohere, what's the best approach?" | Linear, RAG first: dependency order, Temporal met on ingestion before agents, whole app visible from step one |

### 5. Independent plan review (30 Sep 2026)

A fresh agent (not the author) reviewed `PLAN.md` and this file. Verdict: the stack and shape are sound, but four seams were undecided and M0 was underspecified. All 15 findings were accepted and written into `PLAN.md` (see "Design seams" and the appendix). The ones that mattered most:

- **Blockers fixed.**
  - A slot loader that swaps modules at runtime breaks Temporal's workflow sandbox and replay, so slots now resolve once at process start and `ex start` restarts the workers.
  - Recordings keyed by a request hash can't grade a learner's code, so steps use scripted fakes and cassettes are only for reference runs.
  - Agent tokens can't reach the api through workflow history, and Neon's pooler has no LISTEN/NOTIFY, so tokens go through Redis Streams.
- **Facts corrected.** pgvector has no int8 type (it's `halfvec` and `bit`); TEI has no official Apple-silicon image, so a sentence-transformers service with TEI's API runs locally.
- **Added.** Outbox semantics, and Temporal-first as the alternative. Postgres as the single authorisation point across both stores. Keycloak sync details. The BFF login pattern and SSE through Envoy. Time-skipping tests. Temporal updates. Heartbeat cancellation. Per-user token budgets and a kill switch. Reindexing with alias cutover. `graded | guided | lab` step types. An M0 spec appendix.
- **Build order changed.** The agent reference (M2) is written before any exercises, so the run/event schema is settled first.
- **Left for Lucien, then answered:** multi-tenancy in scope (one step); learner path linear, RAG first.

A second independent review through Codex (per `CLAUDE.md`) wasn't possible from the sandbox, where the Codex CLI isn't installed.

Superseded along the way: a Hono/TypeScript backend, Drizzle, pg-boss, better-auth, BM25 on our own Postgres tables, ParadeDB, and folding web and API into one TanStack Start app.

### 6. M0a: infra and tooling (30 Sep 2026)

- **How it ran:** I wrote a contract (`docs/m0a-contract.md`) and the uv skeleton, then four Opus lanes ran in parallel on disjoint files: Python core, infra, the `ex` CLI + slots, and TypeScript. An integrator brought `ex smoke` to green. A fresh Fable reviewer and a read-only Codex review (gpt-6-sol) ran independently; Opus applied 19 accepted fixes, and a fresh Fable verifier reverted each high-risk fix to prove its test goes red. It caught one regression (Temporal outages counted as row attempts), which was fixed in a second round.
- **Lucien's calls:** install OrbStack via brew; **local Postgres is host brew `postgresql@18` + `pgvector`**, not a container (brew `postgresql@14` had been holding 5432; its data, including `lucien_george_com_development`, is still on disk); stop brew `redis`, which shadowed the Compose Valkey; clean the npm, pnpm and brew caches (the disk had 2.4 GiB free); merge with a merge commit.
- **Worth knowing:** neither review found everything. Codex alone caught the logout/refresh race, the slot-switch ordering, relay per-key ordering and the unbound tenant claim; Fable alone caught the gate's blind spot and the template gaps. `minio/minio` is gone from registries (we use `pgsty/minio`). httpx drops custom cookie policies (it copies the cookies into a default-policy jar on every request). FastAPI 0.142 auto-configures its own OTLP exporter unless it's turned off. The openai SDK 3.22 uses `httpx2`.

## Environment gotchas

- **Stale git locks.** The Cowork sandbox cannot delete files inside `.git`, so commits there leave `.git/HEAD.lock` and `.git/index.lock` behind and every later git write fails. On the host: `cd ~/src/luciengeorge/agentic-chat && rm -f .git/HEAD.lock .git/index.lock && git add -A && git commit -m "plan: review fixes, handoff, prep docs"`. If you commit from a sandbox, expect this again.
- **No git identity in the sandbox.** Commit with `git -c user.name="Lucien George" -c user.email="luciengeorge95@gmail.com"`, the identity his other repos use.
- **Path mapping.** Bash sees host folders under `/sessions/<id>/mnt/...`, while the file tools use host paths. Claude's own data folders under `~/Library/Application Support/Claude/` are unreadable, so the raw transcript can't be exported from inside a session.
- **The shared vault.** Other agents write to the same daily note at the same time. Append rather than rewriting, and `git add` only your own paths.
- **Docker.** OrbStack, installed via brew on 30 Sep. Postgres is **not** in Compose: it's brew `postgresql@18` on :5432 (role, password and database all `ac`), reached from containers at `host.docker.internal`. The `psql` on PATH may still be the v14 client; use `/opt/homebrew/opt/postgresql@18/bin/psql`. `ex up` refuses to start if a non-Docker process holds a published port.
- **Private GitHub repos return 404** in the in-app browser, which isn't signed in.
- **Model gotcha (from poof):** the GPT-5.6 series defaults to `reasoning: "none"`. Always set reasoning effort explicitly. His `CLAUDE.md` lists `gpt-6-luna` and `gpt-6-sol` (for Codex), and `gpt-6-luna` is now pinned as the default: it's the cheapest tier, and its reasoning default is medium.

## Where things are

- `PLAN.md`: architecture, decisions, deployment profiles, repo layout, workshop mechanics, curriculum (about 100 steps), milestones, and what to check while scaffolding.
- `docs/interview-prep/spotify/` and `docs/interview-prep/cohere/`: all the prep material. The most useful for building the curriculum:
  - `COHERE_01_rag_fundamentals.md` (the explanations that worked)
  - `COHERE_03_practice_questions.md`
  - `COHERE_09_debugging_round.md` (the basis for section 20)
  - `COHERE_10_model_answer_pharma_airgapped.md`
- Vault: `projects/agentic-chat/index.md` (hub), `topics/building-with-llms/` (the durable AI-systems notes), and daily notes `2026-09-18` and `2026-09-30`.

## Next steps for whoever picks this up

1. Read `PLAN.md` end to end, then `docs/m0a-contract.md` (the names, ports, env vars, slot rule and `ex --json` shapes that everything now depends on).
2. `uv run ex up`, start `pnpm --filter web dev` and `pnpm --filter workshop dev`, then `uv run ex smoke --json` to confirm the stack is green before changing anything.
3. Start M0b the same way M0a ran: a contract first, parallel Opus lanes on disjoint files, an integrator, then a fresh Fable review plus a read-only Codex review, and a fresh verifier on the fixes.
4. Carry the deferred item into section 09.6: enforcing RLS needs a non-owner app role (the owner bypasses RLS unless `FORCE`), `SET LOCAL` tenant context per transaction, and an explicit cross-tenant role for the relay.
5. Log every change to the vault's daily note and the project hub.
