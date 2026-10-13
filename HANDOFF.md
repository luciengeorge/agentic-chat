# Handoff: agentic-chat

For the next agent picking this up. Read this first, then `PLAN.md` (the source of truth for what to build). This file is the history: how the project came about, what Lucien said at each decision, how he learns, and the traps in this environment.

## TL;DR

- **What:** a hands-on workshop repo where Lucien builds a production-grade AI application (a small Cohere North) layer by layer, Epic React style: problem and solution folders, hints inline, tests as the grader, and the running reference app as the lab.
- **Why:** Cohere rejected him after the onsite. The feedback named one gap: "autonomous agent orchestration and state management."
- **State:** **restarting on TypeScript** (1 Oct 2026), on branch `ts-restart`, which starts from the Python M0b work. The Python stack is tagged: `python-m0a` (17b6b0d, merged to `main`) and `python-m0b` (cd6f753, reviewed three rounds, ready to merge, not merged). PLAN.md has been rewritten for the new stack, and nothing of it is built yet. Next: TypeScript M0 in `PLAN.md`.
- **Repo:** `~/src/luciengeorge/agentic-chat` (local git, no remote).

## Who Lucien is

- Full-stack TypeScript engineer at Fyxer (Firebase functions, Firestore, Cloud Tasks, GrowthBook). Personal repos live in `~/src/luciengeorge/`, among them `poof` (an autonomous trading agent on Convex and Vercel), `tanstack-starter-template` and `vite-interview-template`.
- Usual stack: pnpm, Vite, React, TanStack Router, Query and Start, shadcn on Base UI, Tailwind, zod, Vitest (sometimes browser mode), oxlint, oxfmt, tsgo, msw. He first chose a Python backend for this repo, since that's what most AI backends use. On 1 Oct he moved it to his own TypeScript stack so the effort goes into the AI work (§8).
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
- Labs should make effects visible: rankings side by side, denied chunks, a run resuming after the server is killed.

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
- On scope, twice and firmly on 30 Sep: **no shortcuts.** "this is about learning the best practices out there for a production grade AI application." On 1 Oct he narrowed where that applies: production tools still, each built small by hand first, but only for the AI layers he wants to learn. The plumbing around them comes from a framework he knows.

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

A fresh agent (not the author) reviewed `PLAN.md` and this file. Verdict: the stack and shape are sound, but four seams were undecided and M0 was underspecified. All 15 findings were accepted and written into `PLAN.md`. The ones that mattered most:

- **Blockers fixed.**
  - A slot loader that swaps modules at runtime breaks Temporal's workflow sandbox and replay, so slots resolved once at process start and `ex start` restarted the workers. (The same replay concern carries into the TypeScript plan: `ex start` cancels open workflow runs before it swaps files.)
  - Recordings keyed by a request hash can't grade a learner's code, so steps use scripted fakes and cassettes are only for reference runs.
  - Agent tokens can't reach the api through workflow history, and Neon's pooler has no LISTEN/NOTIFY, so tokens went through Redis Streams.
- **Facts corrected.** pgvector has no int8 type (it's `halfvec` and `bit`); TEI has no official Apple-silicon image.
- **Added.** Outbox semantics, and Temporal-first as the alternative. Postgres as the single authorisation point across both stores. Keycloak sync details. The BFF login pattern and SSE through Envoy. Time-skipping tests. Heartbeat cancellation. Per-user token budgets and a kill switch. Reindexing with alias cutover. `graded | guided | lab` step types. An M0 spec appendix.
- **Build order changed.** The agent reference (M2) is written before any exercises, so the run/event schema is settled first.
- **Left for Lucien, then answered:** multi-tenancy in scope (one step); learner path linear, RAG first.

A second independent review through Codex (per `CLAUDE.md`) wasn't possible from the sandbox, where the Codex CLI isn't installed.

Superseded along the way: a Hono/TypeScript backend, Drizzle, pg-boss, better-auth, BM25 on our own Postgres tables, ParadeDB, and folding web and API into one TanStack Start app. (Several of these came back on 1 Oct; see §8.)

### 6. M0a (Python): infra and tooling (30 Sep 2026, tag `python-m0a`)

- **What it built:** uv and pnpm workspaces, Compose with every service, Envoy and a Keycloak realm, the Python `ex` CLI with slots, scripted fakes and cassettes, CI, and a workshop app shell. `ex up` then `ex smoke` passed 6/6, and it merged to `main` (17b6b0d).
- **How it ran:** a contract (`docs/m0a-contract.md`), four Opus lanes in parallel on disjoint files, an integrator, then a fresh Fable review and a read-only Codex review (gpt-6-sol). Opus applied 19 fixes, and a fresh Fable verifier reverted each high-risk fix to prove its test went red. That caught one regression (Temporal outages counted as relay attempts).
- **Worth keeping:** neither review found everything. Codex alone caught the logout/refresh race, the slot-switch ordering, relay per-key ordering and an unbound tenant claim; Fable alone caught the gate's blind spot and the template gaps. So run both.

### 7. M0b (Python): schema, fixtures, fake-workspace (1 Oct 2026, tag `python-m0b`)

- **What it built:** `fixtures/world.yaml` as the single source for people, groups, folders and facts; 46 markdown sources rendered into PDFs, scans, handwriting and DOCX (about 14 MB, byte-identical across builds); Keycloak realms generated from the world; migration `0002` (tenant_id + RLS everywhere, the group closure, `acl_version_seq`); and fake-workspace, a Graph-style SharePoint. `docs/m0b-contract.md` is the contract, and its "Settled during the build" list holds the decisions that carry over.
- **How it ran:** six Opus lanes, an integrator, Fable and Codex reviews, then three fix-and-verify rounds. Round 3 ended at cd6f753 with 595 tests passing and smoke 8/8. It is ready to merge and hasn't been.
- **Lessons:**
  - **Check traps in the built file.** The lexical trap's source was right, but the PDF broke it: the table renderer squeezed columns below their longest word, so contract numbers wrapped mid-token in the text layer (`KPC-2026-014` then `2` on the next line). 8 of 31 ids never appeared whole. Now tables shrink their font instead, and a test reads every built PDF.
  - **Seeded facts can move each other.** Fixing the Q2 complaint mix shifted a shared seeded random stream and silently moved the Q2 resolution rate from 96.8% to 97.7%.
  - **Concurrent subscription ids.** Concurrent subscribes all got the same id, because the id was read after an `await`; 4 of 5 callers would never have been notified. Ids now also carry a per-process nonce, so a restart never reuses one.
  - **A stale realm record.** `ex fixtures` remembered which realm exports Keycloak had loaded by their digest alone, so after a branch switch it trusted a container built from the other branch's exports. The fix keyed the record on the container id too. (Keycloak is gone now, and so is that record.)
  - **The acl_version high-water mark's read order.** The audit must read the mark after the retrieval query (or inside one REPEATABLE READ snapshot). Read before it under READ COMMITTED, the stale-ACL drill would excuse a real leak. This carries into the TypeScript schema.
  - **A stopping rule for reviews.** Each round found smaller things. Round 3 was declared final up front, and anything new went to the next milestone's backlog. Set the rule before round 1 next time.
  - **The shared-stack collision.** I ran a live smoke while a fixer re-ran its drills on the same Docker stack, and we took the stack down under each other. One agent owns the live stack at a time.

### 8. The TypeScript restart (1 Oct 2026)

Mid-afternoon, with M0b ready to merge, Lucien changed course: "the main goal is for me to learn everything about agent orchastration, parsing, vector searching, bm25, reranking, etc. so instead of building everything from scratch, let's use a framework i am familiar with. this way i can focus on the agent orchestration part and the learnings i want to get out of this. So let's restart everything using the https://github.com/luciengeorge/tanstack-starter-template template and adapt it to the 'course' we're building."

| # | Topic | What Lucien said | Result |
|---|---|---|---|
| 1 | Restart | (above) | A restart in this repo from his template. The Python work tagged `python-m0a` and `python-m0b`; branch `ts-restart` |
| 2 | Template versions | "before you use the template make sure the template is up to date in terms of the package versions it uses" | An Opus agent updated the template on branch `chore/deps-2026-10` in its own repo, with no push until Lucien okays it. better-auth had been held at ~1.6 for the Convex adapter; with Convex gone, it moves to 1.7.7 |
| 3 | Database and BM25 | "neon for the cloud? didn't we say paradeDB? do we need to handbuild bm25 or is there a better way" | **ParadeDB everywhere** (`paradedb/paradedb:0.25.11-pg18`: Postgres 18.6, pg_search 0.25.11, pgvector). Neon is out: it retired pg_search on 21 Sep 2026, and its replacement, lakebase_text, exists only on Neon. BM25 is hand-built once as an exercise, then the app uses pg_search |
| 4 | Repo shape | "why would we need pnpm monorepo instead of single app? what are the pros and cons of each?" | **A single app.** A monorepo pays off when parts are published or deployed separately, and nothing here is. The learnable modules live in `src/core/` |
| 5 | Template extras | "none of those are needed i believe" | Convex, Sentry, PostHog, Resend/react-email and Polar removed. Dev auth emails print to the console; seeded users are marked verified |
| 6 | Parsing | "what is docling?" | Explained: IBM's open-source converter that turns PDF and DOCX into structured text with tables, OCR and page numbers. Kept as section 03's comparison, through docling-serve in local Docker |
| 7 | ParadeDB install | He installed ParadeDB himself with its install script | We moved it into the repo's Compose (pinned tag, known dev password), stopped brew `postgresql@18`, which was holding localhost:5432 again, and removed the script's empty container |
| 8 | The other choices | He picked each from the options offered | better-auth with organisations as tenants; the directory from fake-workspace (no Keycloak); Vercel Workflow after a hand-built Postgres version; Cohere-only rerank; exercises with Vitest first and the workshop UI later; the built corpus committed and the renderer retired |

**How the plan changed while it was drafted.** The first draft had hand-built BM25 in the app compared against ParadeDB, and a local bge reranker (transformers.js) next to Cohere. The approved plan uses pg_search in the app and Cohere alone; the local reranker moved to section 21.

**Things the research turned up** (each one is in `PLAN.md`):
- `@paradedb/drizzle-paradedb` (0.5.0, now 0.6.0) pins `drizzle-orm@1.0.0-rc.4`, and better-auth 1.7.7's Drizzle adapter accepts `>=1.0.0-rc.1 <2.0.0`, so the two fit.
- better-auth's CLI is now `auth`; `@better-auth/cli` is deprecated.
- Vercel Workflow issue #4442 breaks the dev server on nitro `3.0.260903-beta`. The fix is merged but not yet released.
- Issue #1003: native modules inside workflow steps fail on Vercel with TanStack Start.
- Calling `start()` from a `createServerFn` is unverified.
- transformers.js's pipeline API scores every rerank candidate 1.0. Call the model directly and apply a sigmoid.
- `docling-serve-cpu` is about 4.4 GB, has an async API, and returns per-item `prov[{page_no, bbox}]`.

**What carried over from the Python work:** `world.yaml`, the corpus (sources and built files) and its traps, fake-workspace's behaviour, the schema rules from `docs/m0b-contract.md`, the curriculum and the review process. **What was dropped:** Python and uv, Temporal, Envoy, Keycloak, OpenSearch, TEI, Redis Streams, MinIO, and Compose for every service (it now runs only ParadeDB and docling).

Several choices superseded on 30 Sep came back: Drizzle, better-auth, ParadeDB and a single TanStack Start app. The goal changed. On 30 Sep it was to learn every production layer; on 1 Oct it narrowed to the AI layers, built on a stack he already knows.

## Environment gotchas

- **Postgres.** ParadeDB owns port 5432, through the repo's Compose. Brew `postgresql@14` and `postgresql@18` are both stopped; don't start them, or they shadow 5432. `@14`'s data (including `lucien_george_com_development`, from the legacy lucien.dev app) is still on disk; ignore it. The `psql` on PATH is the v18 client.
- **Docker** is OrbStack, installed via brew on 30 Sep.
- **Disk is tight.** The handoff note said about 20 GiB free; `df` showed 12 GiB late on 1 Oct. `docling-serve-cpu` alone is about 4.4 GB, so check before pulling images.
- **`.ex/realm-applied.json`** is obsolete (it tracked Keycloak). Delete it if you find it.
- **`cp` is aliased to `cp -i`** in his shell, so scripts use `/bin/cp -f`.
- **One owner for the live stack.** Only one agent runs or restarts the shared Compose stack and dev servers at a time; announce before touching it.
- **One dev server per `.workflow-data/`.** Each dev server has its own in-memory queue, and at boot it re-enqueues every open run it finds on disk. Two servers on the same directory (say one on 3000 and a test server on 3010) would both process the same runs. Give a second server its own `WORKFLOW_LOCAL_DATA_DIR`.
- **`.workflow-data/` is disposable.** It is Workflow's local world: runs, events, hooks and streams as JSON files. With the dev server stopped, deleting it just forgets every local run.
- **Bumping the ParadeDB image doesn't update the installed extension.** After changing the tag in `compose.yaml`, run `ALTER EXTENSION pg_search UPDATE` in `ac` and in `template1` (the test databases are copied from it), or queries fail with errors such as `function paradedb.ctid_is_valid(tid) does not exist`. A fresh volume needs nothing.
- **Vitest's module cache and slots.** Vitest 5.0.4 caches transformed modules on disk by default, and the cache can't tell a slotted run from a reference run. `learnSlots()` turns it off; keep it off.
- **The `@workflow/builders` patch.** `patches/@workflow__builders@5.0.4.patch` lets `learnSlots()` reach Workflow's step bundles. On every `workflow` upgrade, `pnpm install` fails until the patch is re-made (`pnpm patch @workflow/builders@<version>`) or dropped, if upstream has added an esbuild plugin option by then. `docs/workflow-notes.md` (b) explains it.
- **The shared vault.** Other agents write to the same daily note at the same time. Append rather than rewriting, and `git add` only your own paths.
- **Private GitHub repos return 404** in the in-app browser, which isn't signed in.
- **Model gotcha (from poof):** the GPT-5.6 series defaults to `reasoning: "none"`. Always set reasoning effort explicitly. His `CLAUDE.md` lists `gpt-6-luna` and `gpt-6-sol` (for Codex), and `gpt-6-luna` is pinned as the default: it's the cheapest tier, and its reasoning default is medium.

## Where things are

- `PLAN.md`: architecture, design seams, decisions, deployment profiles, repo layout, workshop mechanics, the curriculum (107 steps), milestones, what to verify while scaffolding, and the M0 spec.
- `docs/m0b-contract.md`: the Python M0b contract. Its schema and fake-workspace sections, and "Settled during the build", still describe the behaviour to port. `docs/m0a-contract.md` is history only.
- `fixtures/`: `world.yaml`, the corpus sources, the built corpus, and `corpus/README.md` with the trap table.
- `~/src/luciengeorge/tanstack-starter-template`, branch `chore/deps-2026-10`: the updated template M0 starts from.
- `docs/interview-prep/spotify/` and `docs/interview-prep/cohere/`: all the prep material. The most useful for building the curriculum:
  - `COHERE_01_rag_fundamentals.md` (the explanations that worked)
  - `COHERE_03_practice_questions.md`
  - `COHERE_09_debugging_round.md` (the basis for section 20)
  - `COHERE_10_model_answer_pharma_airgapped.md`
- Vault: `projects/agentic-chat/index.md` (hub), `topics/building-with-llms/` (the durable AI-systems notes), and daily notes `2026-09-18`, `2026-09-30` and `2026-10-01`.

## Next steps for whoever picks this up

1. Read `PLAN.md` end to end, then the sections of `docs/m0b-contract.md` that the M0 appendix points to.
2. Check the template's `chore/deps-2026-10` branch is finished and that Lucien has okayed it. M0 starts from it.
3. Build M0 per `PLAN.md`, the way M0a and M0b ran: a contract first, parallel Opus lanes on disjoint files, an integrator, then a fresh Fable review and a read-only Codex review, and a fresh verifier that reverts each fix to prove its test goes red. Set the stopping rule for review rounds before the first one.
4. Run the Workflow spike early. It settles the workflow and nitro pins (#4442), and whether `start()` works from a server function.
5. Carry the deferred item into section 09.6: enforcing RLS needs a non-owner app role (the owner bypasses RLS unless it is forced), `SET LOCAL` tenant context per transaction, and an explicit cross-tenant role for background jobs.
6. Log every change to the vault's daily note and the project hub.
