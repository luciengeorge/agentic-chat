# The Cohere 60-Minute Interview Spine

> Read the North primer and RAG fundamentals first. This doc is the **script** — what you actually do, minute by minute.
>
> **Critical difference from a standard system design interview:** Cohere's design exercise is only **30-35 minutes**, not 45-50. That's tight. You cannot afford a slow start or a rambling architecture walkthrough. Efficiency is part of the test.

---

## The timeline (from their own PDF)

| Phase | Time | What's happening |
|---|---|---|
| **Introduction** | 5-10 min | Intros, background chat, they set up the problem |
| **Design Exercise** | 30-35 min | The actual work |
| **Q&A** | 5-10 min | Your questions for them |

Budget inside the 30-35 minute design exercise:

| Sub-phase | Time | Why |
|---|---|---|
| Scope + constraints | 4-5 min | They explicitly list "Clarify the Problem" as tip #1 |
| High-level architecture | 10-12 min | Draw it, narrate it |
| Deep dive (1 area) | 10-12 min | Where you show depth |
| Trade-offs + what breaks + what's next | 4-5 min | They list "Discuss Trade-Offs" and "Look Ahead" as explicit tips |

**Watch the clock.** If you're 15 minutes in and still scoping, you've failed the exercise regardless of how good your questions were.

---

## Before you start: Excalidraw prep

They suggest Excalidraw. **Set it up the day before and practise.** Fumbling with a drawing tool burns minutes you don't have.

Practical tips:

- **Pre-make a scratch file** with a few labelled rectangles you can duplicate fast. Don't build shapes from scratch live.
- **Learn 4 shortcuts:** `R` rectangle, `A`/`arrow` for arrows, `T` text, `V` selection. That's all you need.
- **Draw left-to-right or top-to-bottom** consistently. Pick one and stick to it.
- **Label every arrow.** An unlabelled arrow is ambiguous; a labelled one ("query embedding", "ACL filter", "top-100 candidates") does narrative work for you.
- **Don't beautify.** Nobody is grading aesthetics. Straight lines and legible labels, that's it.
- **Zoom out periodically** so they can see the whole picture, and say "let me zoom out so you can see the whole thing" — small thing, reads as considerate.

---

## Phase 1 — Scope (4-5 minutes). Ask these.

Their tip #1 is literally *"Clarify the Problem... What's the core goal? Are there any constraints or ambiguities?"* So this is being explicitly graded.

**The six questions, adapted for an enterprise AI context:**

1. **"Who are the users, and how many?"**
   → Employees of one enterprise customer? Multiple tenants? Default: single enterprise, ~10K employees, ~2K daily active.

2. **"What's the corpus? How many documents, what formats, how fast does it change?"**
   → Default: ~5M documents across SharePoint/Drive/Confluence/Slack, mixed formats (PDF, slides, spreadsheets, wiki pages), ~50K changes/day.

3. **"Where does this run?"** — *the Cohere-specific question*
   → *"Is this our SaaS, a customer VPC, on-prem, or air-gapped? Because that constrains what components I can even use."* This single question signals you understand their business.

4. **"What are the security requirements?"**
   → Document-level permissions? Data residency? Audit requirements? Default: yes to all — assume regulated industry.

5. **"Is this Q&A only, or do agents take actions?"**
   → Read-only retrieval is a much smaller problem than an agent that can send emails and update records. Pin this down.

6. **"What's out of scope?"**
   → Model training/fine-tuning? The UI? Billing? Get them to rule things out.

**And one non-functional question:**

7. **"What matters most — answer quality, latency, or cost?"**
   → For enterprise, usually quality and security over latency. But ask.

**Write the answers somewhere visible on the canvas.** Literally a text box in the corner labelled "Constraints." It shows discipline and gives you something to point back to when justifying decisions later.

---

## Phase 2 — High-level architecture (10-12 min)

### The default drawing

For the most likely question (enterprise AI assistant over internal docs), draw this:

```
   ┌─────────────────────────────────────────────────────────────┐
   │              CUSTOMER PERIMETER (VPC / on-prem)             │
   │                                                             │
   │   Web UI / Slack / API                                      │
   │         │                                                   │
   │         ▼                                                   │
   │   ┌───────────┐                                             │
   │   │  Gateway  │  authn, rate limit, tenant routing          │
   │   └─────┬─────┘                                             │
   │         │                                                   │
   │         ▼                                                   │
   │   ┌────────────────┐      ┌──────────────────┐              │
   │   │  Orchestrator  │◄────►│  Identity / ACL  │              │
   │   │  (agent loop)  │      │     service      │              │
   │   └───┬────────┬───┘      └──────────────────┘              │
   │       │        │                                            │
   │       │        └──────────────┐                             │
   │       ▼                       ▼                             │
   │  ┌─────────┐            ┌──────────┐                        │
   │  │Retrieval│            │  Tools   │  email, CRM, calendar  │
   │  │ service │            │ registry │                        │
   │  └────┬────┘            └──────────┘                        │
   │       │                                                     │
   │       ├──► Vector store (chunks + embeddings + ACLs)        │
   │       ├──► Lexical index (BM25)                             │
   │       └──► Metadata DB (Postgres)                           │
   │                                                             │
   │   ┌──────────────────────────────────────────┐              │
   │   │  Model serving (GPU)                      │             │
   │   │  Embed · Rerank · Command                 │             │
   │   └──────────────────────────────────────────┘             │
   │                                                             │
   │   ══════════ INGESTION (async) ══════════                   │
   │   Connectors → Parse → Chunk → Embed → Index                │
   │   (SharePoint, Drive, Slack, Confluence...)                 │
   │                                                             │
   └─────────────────────────────────────────────────────────────┘
```

**Draw the perimeter box first.** Literally the outer rectangle labelled "customer perimeter." It's a one-second move that instantly communicates you understand Cohere's core constraint. Everything lives inside it.

### The narration (this is what you say while drawing)

Roughly 10 minutes, in this order:

**(1) Frame it — 30 seconds**
> *"There are two flows here: an ingestion flow that gets enterprise documents into a searchable index, and a query flow where a user asks a question and gets a grounded answer. I'll do the query path first since that's the user-facing one, then come back to ingestion. And I'm drawing everything inside a customer perimeter box, because the deployment constraint shapes every component choice."*

**(2) Query path — 4-5 minutes**
> *"A user asks a question from the web UI or Slack. It hits a gateway doing authentication, rate limiting, and tenant routing. The gateway passes to an orchestrator — this is the component that decides what to do with the question.*
>
> *First thing the orchestrator does is resolve the user's identity into a full principal set — their user ID, every group they're in, every role. That comes from an identity service synced from the customer's directory. This matters because retrieval has to be permission-scoped.*
>
> *The orchestrator calls the retrieval service with the query and the principal set. Retrieval does two stages: first a high-recall stage — dense vector search over embedded chunks, plus BM25 lexical search for exact identifiers, fused with reciprocal rank fusion — constrained by the user's permissions. That gives maybe 100-200 candidates. Then a second stage — a cross-encoder reranker scores those candidates against the query precisely, and we take the top 5-10.*
>
> *Those chunks go into a prompt with the question and grounding instructions, and the generation model produces an answer with citations. We stream tokens back to the user."*

**(3) Ingestion path — 3-4 minutes**
> *"Separately and asynchronously: connectors pull from the customer's systems — SharePoint, Drive, Confluence, Slack. Each connector does an initial full crawl then switches to incremental sync, ideally driven by change notifications rather than polling.*
>
> *Each document goes through a pipeline: parse it (extract text and structure from PDFs, slides, spreadsheets — this is non-trivial and it's where a document-parsing model earns its keep), chunk it structure-aware, embed each chunk, and index into both the vector store and the lexical index.*
>
> *Crucially, at ingestion we also capture the document's ACL from the source system and stamp it onto every chunk. That's what makes permission-filtered retrieval possible later."*

**(4) Model serving — 1 minute**
> *"All three models — embedding, reranking, generation — run on GPUs inside the perimeter. The embedding model gets hit hard during ingestion and lightly per query. The reranker gets hit once per query with a batch of candidates. Generation is the expensive one. I'd serve these behind an inference layer doing continuous batching for GPU efficiency."*

**(5) Hand over — 15 seconds**
> *"That's the shape. Where do you want to go deeper — retrieval quality, the ingestion pipeline, permissions, agent behaviour, or the deployment/serving side?"*

---

## Phase 3 — Deep dive (10-12 min). Pick ONE.

You'll have roughly 10-12 minutes. That's one area, properly, not three shallowly.

**Default pick: permission-aware retrieval.** It's the most Cohere-specific, the most differentiated, and the one most candidates can't do. If the interviewer leaves the choice to you, take this.

### Deep dive A — Permission-aware retrieval (recommended default)

Cover, in order:

1. **The threat model.** *"The failure mode here isn't a wrong answer — it's surfacing a document the user shouldn't see. That's a security incident. So permissions can't be a post-processing step."*

2. **ACLs at ingestion.** Every chunk carries `allowed_principals` copied from the source document, plus an `acl_version`.

3. **Principal resolution at query time.** User → their full transitive set of groups and roles. Nested groups mean tree-walking; cache it with event-driven invalidation.

4. **Enforcement strategy.** Pre-filter vs post-filter vs over-fetch-and-filter. Explain the ANN performance problem with selective pre-filters: if only 0.1% of chunks pass the filter, HNSW has to traverse enormously more of the graph to find k results, and latency blows up. The pragmatic answer is over-fetch with an adaptive multiplier, plus pre-filtering where the filter is cheap and non-selective (e.g. tenant ID).

5. **ACL staleness.** Permissions change constantly. Your sync lag is a security window. Drive it with change events, define an SLO in minutes, and for the highest-sensitivity content consider a live authorisation check against the source system before returning results.

6. **Conversation history.** Earlier turns in a session carry retrieved context. If permissions change mid-session, or if the session is shared, that's a leak path. Re-scope per turn.

7. **Audit.** `(user_id, query_hash, returned_chunk_ids, denied_chunk_ids, acl_version, timestamp)` for every retrieval.

### Deep dive B — Ingestion at scale

If they steer you here: connector architecture, initial crawl vs incremental sync, parsing hard formats, chunking strategy, embedding throughput and batching, idempotent re-indexing, handling deletes and moves, backfill after an embedding model upgrade (you have to re-embed the whole corpus — plan for it), rate limits on source APIs, per-tenant fairness.

### Deep dive C — Retrieval quality

Two-stage architecture in detail, hybrid search and RRF, chunking trade-offs, query understanding (rewriting, decomposition, HyDE), recency and authority boosting, handling conflicting sources, and the evaluation story — golden sets, recall@k, NDCG, faithfulness, CI regression testing.

### Deep dive D — Agent loop

Tool registry and schemas, the plan-act-observe cycle, iteration caps, error handling, authorisation on *actions* (not just reads) using the acting user's identity, human-in-the-loop approval for consequential actions, streaming intermediate state, full trace observability, and what happens when an agent gets stuck.

### Deep dive E — Private deployment / serving

GPU sizing and the "runs on two GPUs" constraint, continuous batching, KV cache management, model quantisation, what changes in air-gapped mode (no telemetry egress, offline model updates via physical media, no external package registries), upgrade and rollback strategy, per-tenant isolation, and observability without data egress.

---

## Phase 4 — Volunteer these (4-5 min)

Their tips list "Discuss Trade-Offs" and "Look Ahead" explicitly. Don't wait to be asked.

### Trade-offs to name

1. **Managed vector DB vs self-hosted** — *"I'd self-host something like Qdrant or pgvector rather than use a managed service, because air-gapped deployment rules out SaaS dependencies. We give up some operational convenience for deployability."*
2. **Chunk size** — *"Smaller chunks give precise citations but lose context; larger chunks give context but dilute retrieval. I'd start at ~500 tokens with overlap and tune against evals."*
3. **Pre-filter vs post-filter for ACLs** — *"Pre-filtering is correct but can destroy ANN performance with selective filters; post-filtering is fast but can return too few results. I'd over-fetch and filter, with an adaptive multiplier."*
4. **Sync freshness vs source system load** — *"Tighter freshness means more aggressive polling, which hits customer API rate limits. Event-driven sync where the source supports it, polling as fallback."*
5. **Agent autonomy vs safety** — *"I'd ship with supervised autonomy — the agent proposes consequential actions and a human approves — and loosen it per-action-type as we build confidence."*

### "What breaks first"

1. **Permission leaks from stale ACLs** — the highest-severity failure, and the most likely one to actually happen
2. **Ingestion backlog** — a customer connects a 5M-document SharePoint and the embedding pipeline takes days; GPU contention with live query traffic
3. **Retrieval quality degradation as the corpus grows** — recall@k drops as the index gets denser, and nobody notices without evals

### "Look ahead" — what you'd do next

- Re-embedding strategy for when the embedding model is upgraded (whole-corpus reindex, dual-index cutover)
- Per-tenant fine-tuning or adapter-based customisation that stays in their environment
- Expanding from Q&A to multi-step agents
- Caching layer for repeated queries (semantic cache, not just exact-match)

---

## Phase 5 — Your questions for them (5-10 min)

This is a scored part of the interview. Have 5 ready, ask 2-3 based on how the conversation went.

**Good ones for Cohere specifically:**

1. *"How much of North's architecture has to flex per customer deployment? Is it one system with configuration, or does each large enterprise get meaningful customisation?"*
2. *"What's the hardest part of the air-gapped story in practice — is it model updates, observability, or something I wouldn't expect?"*
3. *"How do you handle evaluation when you can't see customer data? Do customers run their own evals, or is there a way to measure quality without data egress?"*
4. *"Where does the boundary sit between Compass and North — is Compass a service North consumes, or is it more integrated than that?"*
5. *"What's the thing about building for regulated enterprises that surprised you most coming from a more typical software background?"*

**Generic-but-solid backups:**

6. *"What does the first 90 days look like for someone in this role?"*
7. *"What's the biggest technical challenge the team is working on right now?"*

Avoid: anything answerable from their website, anything about comp (that's for the recruiter), anything that sounds like you're interviewing for a different company.

---

## The meta-advice: what they said they're grading

Straight from their PDF, with what each actually means:

| Their tip | What they're testing |
|---|---|
| "Clarify the Problem" | Do you jump to solutions or gather requirements first? |
| "Think Holistically" | Can you decompose and show how parts connect? |
| "Discuss Trade-Offs" | Do you have opinions with reasons, or just recite patterns? |
| "Keep It Practical" | Would this actually work, or is it a whiteboard fantasy? |
| "Communicate Clearly" | Can you think out loud and take feedback without getting defensive? |
| "Look Ahead" | Can you anticipate change and failure? |
| "Familiarise yourself with Cohere" | Did you do the homework? |

Note what's **not** on that list: correctness, completeness, knowing the right answer. They say explicitly *"It's not about memorizing the 'right' answer."* This is a **process** interview. Narrate your thinking constantly. Say "I'm choosing X because Y, though Z would also be defensible." That's the behaviour being graded.

---

## The 7 things to have locked before you walk in

1. The **scoping questions**, especially *"where does this deploy?"*
2. The **perimeter box** as your first drawing move
3. **Two-stage retrieval** and why — recall then precision
4. **Permission-aware retrieval** end to end — this is your differentiator
5. **Three trade-offs** you can name without prompting
6. **Excalidraw** muscle memory — practise once the day before
7. **Three questions** for them

---

## Day-by-day plan (one week out)

- **Day 1-2:** Read the North primer and RAG fundamentals. Don't memorise, absorb.
- **Day 3:** Read the practice questions doc. For each, sketch the architecture on paper in 10 minutes.
- **Day 4:** Rehearse the high-level narration out loud, twice. Time it — target 10-12 minutes.
- **Day 5:** Deep-dive rehearsal: permission-aware retrieval, out loud, 12 minutes uninterrupted.
- **Day 6:** Mock interview. Set up Excalidraw and actually draw during it.
- **Day 7:** Light review of the primer, prep your questions for them, sleep.
