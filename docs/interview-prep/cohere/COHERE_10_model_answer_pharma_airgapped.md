# Model Answer — Pharma, Air-Gapped

> The scenario from the second mock. Meaningfully harder than the financial services one in three ways: the corpus is **ten times bigger**, the deployment is **air-gapped from day one**, and the document sizes are **wildly skewed**.
>
> This is the scenario where the Matryoshka and quantisation material stops being trivia and starts being load-bearing.

---

## The scenario

- Pharmaceutical company, ~40,000 employees, **~5,000 daily active**
- Usage is **bimodal**: ~500 regulatory/medical-writing staff use it heavily, thousands of bench scientists use it occasionally
- **~8 million documents / ~800 million pages:**
  - 500K regulatory submissions & clinical trial reports, **~1,500 pages each** (some past 10,000)
  - 200K SOPs and controlled documents, ~15 pages
  - 5M lab records, ~5 pages, **many scanned, some handwritten**
  - ~2.3M memos, minutes, literature, ~10 pages
- Change rate **low** — ~5,000 docs/day, most of the corpus is effectively frozen
- **Air-gapped. No internet connection, ever. Hard contractual requirement.**
- Citations mandatory — anything feeding a regulatory filing must be traceable to source

---

## Phase 1 — Scoping

Same six questions as always, but **ask the deployment one early here**, because the interviewer drops hints (*"I spend most of my week on installs without internet access"*) and because the answer invalidates half your default component choices.

> 1. *"How many users, and what daily-active number?"*
> 2. *"How many documents, across what systems, and what's the size distribution?"* ← the size question matters enormously here
> 3. *"How fast does the corpus change?"*
> 4. **"Where does this deploy — our cloud, their VPC, on-prem, air-gapped?"**
> 5. *"Document-level permissions? And what's the regulatory frame — 21 CFR Part 11?"*
> 6. *"Read-only Q&A, or do we need agents taking actions?"*
> 7. *"Anything out of scope?"*

**The pharma-specific one worth asking:** *"Do we need point-in-time retrieval? If a regulator asks what SOP-4471 said in March 2024, does the system have to answer that?"*

That question is a differentiator. It reveals whether the data model needs document **versioning**, which most candidates never consider. In regulated manufacturing the answer is usually yes, and it changes the index design.

---

## Phase 2 — Capacity

> *"Let me size this before I design anything.*
>
> *Five thousand daily actives at roughly ten queries each is fifty thousand queries a day — well under one QPS average, a handful at peak. So query throughput is a non-issue and I won't design for it.*
>
> *The corpus is the interesting part. Eight million documents but eight hundred million pages, and that skew matters: six percent of the documents are ninety-four percent of the content. At roughly four hundred words a page, a page is about one chunk, so I'm looking at the order of **eight hundred million chunks**.*
>
> *At 1024 dimensions in float32 that's 800 million times 1024 times 4 bytes — about **3.3 terabytes** of raw vectors, call it 4 to 6 terabytes with graph, payload and headroom. That does not fit in memory on one machine, so unlike most of these problems I genuinely do have a scale decision to make.*
>
> *Three levers. I can shard across nodes. I can cut dimensions — Embed v4 is Matryoshka, so truncating to 512 halves it without re-embedding. Or I can quantise — int8 is a further four-fold reduction for minimal quality loss.*
>
> *Combining the second and third: 512 dimensions at int8 is around **410 gigabytes**, which fits comfortably on a single large node with room to spare. I'd measure recall@k at each setting against a golden set before committing, but I'd expect to land somewhere in that region rather than sharding on day one.*
>
> *Ingestion is the other cost centre, and I'd want to come back to the handwritten lab records specifically — OCR on handwriting is a different problem from OCR on scanned print."*

### Why this is the strongest capacity section of any of these scenarios

Most of these problems end at *"not a scale problem, moving on."* **This one doesn't.** 3.3 TB genuinely forces a decision, and the decision has three named options with quantified outcomes:

| Configuration | Index size | Verdict |
|---|---|---|
| 1024 dims, float32 | 3.3 TB | Must shard |
| 512 dims, float32 | 1.6 TB | Still must shard |
| 512 dims, int8 | 410 GB | **Single large node** |
| 256 dims, int8 | 205 GB | Comfortable, check recall |
| 1024 dims, binary + rescore | ~100 GB RAM + 3.3 TB disk | Works, more moving parts |

Saying *"I'd measure recall at each and pick the smallest that clears the bar"* is the whole point. It shows the numbers drive the decision rather than decorate it.

---

## Phase 3 — Architecture

### The diagram

```
╔══════════════════════════════════════════════════════════════════════════╗
║  AIR-GAPPED CUSTOMER ENVIRONMENT — no egress, ever                       ║
║                                                                          ║
║   Scientist / regulatory staff                                           ║
║            │                                                             ║
║            ▼                                                             ║
║   ┌─────────────────┐         ┌──────────────────────┐                   ║
║   │  Gateway        │────────▶│  Identity service     │                  ║
║   │  Envoy / Kong   │         │  syncs from their AD  │                  ║
║   │  TLS·authn·rate │◀────────│  → principal set      │                  ║
║   └────────┬────────┘         └──────────────────────┘                   ║
║            │                                                             ║
║            ▼                                                             ║
║   ┌─────────────────┐                                                    ║
║   │  Orchestrator   │                                                    ║
║   └────────┬────────┘                                                    ║
║            │                                                             ║
║            ▼                                                             ║
║   ┌────────────────────────────────────────────────┐                     ║
║   │  RETRIEVAL SERVICE                             │                     ║
║   │                                                │                     ║
║   │  0. query rewrite / expansion                  │                     ║
║   │                                                │                     ║
║   │  1. HIGH RECALL          ┌──────────────────┐  │                     ║
║   │     dense ANN ∥ BM25 ────│ Vector store     │  │                     ║
║   │     fused with RRF       │ Qdrant / Milvus  │  │                     ║
║   │     cheap pre-filters    │ 512d · int8      │  │                     ║
║   │            │             └──────────────────┘  │                     ║
║   │            │             ┌──────────────────┐  │                     ║
║   │            │─────────────│ BM25 index       │  │                     ║
║   │            ▼             └──────────────────┘  │                     ║
║   │  2. ACL FILTER — intersect principal set       │                     ║
║   │     over-fetch 600 → ~150 survive              │                     ║
║   │            │                                   │                     ║
║   │            ▼                                   │                     ║
║   │  3. HIGH PRECISION — cross-encoder rerank      │                     ║
║   │            │                    → top 8        │                     ║
║   └────────────┼───────────────────────────────────┘                     ║
║                ▼                                                         ║
║   ┌─────────────────────────────┐                                        ║
║   │ Prompt assembly             │                                        ║
║   │ chunks + doc IDs + page refs│                                        ║
║   │ + grounding instructions    │                                        ║
║   └────────────┬────────────────┘                                        ║
║                ▼                                                         ║
║   ┌─────────────────────────────┐                                        ║
║   │ Generation (Command)        │                                        ║
║   └────────────┬────────────────┘                                        ║
║                ▼                                                         ║
║   ┌─────────────────────────────┐                                        ║
║   │ CITATION VALIDATOR          │ ← do cited IDs exist AND appear         ║
║   │ reject/flag fabricated refs │   in the context we supplied?           ║
║   └────────────┬────────────────┘                                        ║
║                ▼                                                         ║
║        stream answer + verified citations                                ║
║                                                                          ║
║  ─────────────────────── INGESTION (async) ───────────────────────       ║
║                                                                          ║
║   Their DMS (Veeva-like) · file shares · lab systems                     ║
║            │                                                             ║
║            ▼                                                             ║
║   ┌──────────────────────────────────────────────────┐                   ║
║   │ Connectors — crawl, then incremental             │                   ║
║   └────────────────────┬─────────────────────────────┘                   ║
║                        ▼                                                 ║
║   ┌──────────────────────────────────────────────────┐                   ║
║   │ SPLITTER — large docs → page-range sub-jobs      │ ← the skew fix     ║
║   │ a 10,000pp submission becomes 100 × 100pp jobs   │                   ║
║   └────────────────────┬─────────────────────────────┘                   ║
║                        ▼                                                 ║
║   ┌──────────────────────────────────────────────────┐                   ║
║   │ Work queue — per-source, incremental > backfill  │                   ║
║   └────────────────────┬─────────────────────────────┘                   ║
║                        ▼                                                 ║
║   ┌──────────────────────────────────────────────────┐                   ║
║   │ PARSE                                            │                   ║
║   │  · native PDF → text layer (ms)                  │                   ║
║   │  · scanned print → OCR (~3s/page)                │                   ║
║   │  · handwritten → OCR + confidence score          │                   ║
║   │    low confidence → human review queue           │                   ║
║   │  · TABLES kept intact — clinical data is the     │                   ║
║   │    highest-value content and splitting kills it  │                   ║
║   └────────────────────┬─────────────────────────────┘                   ║
║                        ▼                                                 ║
║   ┌──────────────────────────────────────────────────┐                   ║
║   │ CHUNK (structure-aware) → stamp ACL + version    │                   ║
║   │   + doc_id + page_no + valid_from/valid_to       │                   ║
║   └────────────────────┬─────────────────────────────┘                   ║
║                        ▼                                                 ║
║   ┌──────────────────────────────────────────────────┐                   ║
║   │ EMBED (batched, GPU) → upsert to both indexes    │                   ║
║   └──────────────────────────────────────────────────┘                   ║
║                                                                          ║
║   ┌──────────────────────────────────────────────────┐                   ║
║   │ MODEL SERVING — their GPUs                        │                  ║
║   │ Embed · Rerank · Command (4-bit, 2×H100)          │                  ║
║   │ separate pools: bulk ingestion vs interactive     │                  ║
║   └──────────────────────────────────────────────────┘                   ║
║                                                                          ║
║   ┌──────────────────────────────────────────────────┐                   ║
║   │ Postgres (metadata, versions, job state)          │                  ║
║   │ MinIO (raw documents — NOT S3)                    │                  ║
║   │ Prometheus + Grafana — LOCAL ONLY, no egress      │                  ║
║   │ Audit log — append-only, 21 CFR Part 11           │                  ║
║   └──────────────────────────────────────────────────┘                   ║
╚══════════════════════════════════════════════════════════════════════════╝
```

### The narration

> **First move: the perimeter.** I'm drawing a box round everything and labelling it air-gapped. That's not decoration — it rules out entire categories of component, and I'd rather establish it before I put anything inside it than retrofit later.
>
> Concretely, what air-gapped costs me: **no managed vector database** — no Pinecone, so Qdrant or Milvus or pgvector, something that ships as a container. **No managed API gateway** — Envoy or Kong rather than AWS API Gateway. **Object storage is MinIO, not S3.** **Observability is local** — Prometheus and Grafana on their hardware, because nothing can phone home. **Model updates arrive on physical media** rather than being pulled from a registry, so I need versioned artefacts with checksums and an offline validation step. **Every dependency is vendored into the container images**, because there's no package registry to reach. And **licensing has to work offline.**
>
> The one that's least obvious and matters most: **we can never look at this customer's data.** So debugging has to work through diagnostics the customer can inspect and choose to send us, and evaluation has to be something they run themselves with tooling we ship. I'll come back to that.
>
> **Query path.** A scientist asks a question. It hits the gateway — TLS, authentication, rate limiting, routing. Worth noting the bimodal usage here: five hundred heavy users generating most of the traffic means I'd want per-user rate limits rather than a global one, so a regulatory writer running a hundred queries can't degrade things for everyone else.
>
> The orchestrator resolves identity first — user ID plus every group and role, expanded transitively from their Active Directory. Cached with event-driven invalidation.
>
> Then retrieval. Query rewriting first, because scientists ask terse questions with heavy domain shorthand. Then stage one for recall: dense ANN and BM25 in parallel, fused with RRF. BM25 earns its place emphatically in this domain — people search for compound codes, protocol numbers, batch IDs, `SOP-4471`. An embedding model has no idea what those are.
>
> Cheap filters get pushed into the search — document type, language. The expensive one, the principal-set intersection, runs after on a bounded candidate set, so I over-fetch six hundred to end up with about a hundred and fifty. Then the cross-encoder reranks those to eight.
>
> **Then something this domain needs that most don't: a citation validator.** The brief said answers feed regulatory filings. Instructing the model to cite isn't sufficient — models fabricate identifiers. So after generation I check every cited ID actually exists *and* actually appeared in the context we supplied. Anything else gets flagged or stripped. In a regulatory context a wrong citation is worse than no citation, because someone downstream will rely on it.
>
> **Ingestion, and here the size skew drives the design.** Six percent of documents are ninety-four percent of the pages, and a ten-thousand-page submission can't be one unit of work — a worker would be tied up for hours and block the queue behind it, and a failure at page nine thousand loses everything.
>
> So there's a **splitter** ahead of the queue: large documents become page-range sub-jobs, processed in parallel and checkpointed independently. A ten-thousand-page submission becomes a hundred hundred-page jobs. That also fixes the memory problem, since nothing has to hold a full parse in RAM.
>
> Parsing is where the real cost sits. Native PDFs extract in milliseconds. Scanned print needs OCR at a few seconds a page. **Handwritten lab records are a third case** — OCR accuracy on handwriting is much lower, so I'd want a confidence score per page and anything below threshold routed to a human review queue rather than silently indexed as garbage. Garbage in the index is worse than a gap, because it produces confident wrong answers.
>
> **Tables need explicit handling.** Clinical data tables are the highest-value content in this corpus and naive chunking destroys them — split a table across chunks and every piece is meaningless. Keep them intact and serialise them with their headers.
>
> Then chunking, and stamping each chunk with the source document ID, the page number — needed for precise citations — the ACL, and a **validity window**. That last one is the point-in-time retrieval requirement: in regulated manufacturing you must be able to answer what a procedure said on a given date, so I'd model documents as versioned with `valid_from` and `valid_to` rather than overwriting, and let queries optionally specify an as-of date. Default to current, but the history has to be there.
>
> Then embedding on their GPUs and upsert to both indexes.
>
> **Model serving** runs on their hardware. Command at four-bit quantisation fits on two H100s, which matters a lot when the customer is buying the GPUs. I'd keep bulk ingestion embedding on a separate pool from interactive traffic — a backfill of eight hundred million chunks will starve live queries otherwise.
>
> That's the shape. Happy to go deeper on the air-gapped operational story, the ingestion pipeline, or retrieval.

---

## Phase 4 — Deep dive: operating air-gapped

The most distinctive deep dive available in this scenario. Five beats.

> **What it's for:** making a system we can never observe both operable by the customer and improvable by us.
>
> **The happy path.** Everything ships as versioned container images with all dependencies vendored. Install is a Kubernetes deployment from a local registry seeded off physical media. Observability is Prometheus and Grafana running on their hardware, with dashboards the customer's own platform team uses. Model updates are signed artefacts delivered on media, checksummed and validated offline before rollout.
>
> **The decision I'd defend:** **the customer owns evaluation.** We ship the eval harness and the tooling to build a golden set; they build it from their own queries and they hold the results. That sounds like abdication and it isn't — it's the only design that works when we can't see their data, and it has a real side benefit, which is that their golden set reflects their actual domain far better than anything we could construct. A pharma golden set full of regulatory queries is more useful to them than a generic one from us.
>
> **What's hard.** Two things.
>
> First, **we're blind exactly where we most need sight.** Our largest, most regulated customers are the ones we can observe least. So diagnostics have to be self-contained: when something breaks, we generate a support bundle — logs, metrics, config, no document content — that the customer inspects and chooses to send. That review step isn't friction to be minimised, it's the thing that makes them willing to send anything at all.
>
> Second, **upgrades are genuinely risky.** No staged rollout across a fleet, no canary to catch a regression before it spreads. Each install is its own blast radius. So: strong backward compatibility guarantees, dual-index migration for anything touching embeddings, and a tested rollback path — because "roll forward and fix it" isn't available when the next delivery is physical.
>
> **The trade-off I'd revisit:** how much aggregate telemetry we ask to export. Nothing means we learn nothing across the fleet; too much and the customer's security team declines and we get nothing anyway. I'd start with a small, explicitly enumerated set of counters — no content, no queries — presented as a reviewable file rather than a background process. Expand only as trust is earned. The instinct to instrument everything is exactly wrong here.

---

## What makes this answer strong

**The perimeter comes first**, with the *consequences* named component by component. Drawing the box is cosmetic; saying "no Pinecone, no AWS API Gateway, no S3, no hosted observability" is substantive.

**The capacity math forces a real decision.** 3.3 TB doesn't fit, and there are three named levers with quantified outcomes. This is the one scenario where the Matryoshka and quantisation material genuinely pays.

**The skew drives a concrete component** — the splitter — rather than being noted and dropped.

**Stated requirements survive to the end.** Citations were in the brief; the citation validator is on the diagram.

**Domain specifics land throughout**: handwriting confidence thresholds, table preservation, `SOP-4471` as a BM25 example, point-in-time retrieval for regulators. Each is small and each signals you were listening rather than pattern-matching.

**The blindness problem is treated as the design centre**, not an afterthought. For a Cohere interview that is the differentiating insight, and it's the thing the interviewer actually lives with.

---

## The three numbers to memorise

```
800M chunks          from 800M pages, ~1 chunk per page
3.3 TB               at 1024 dims, float32 — doesn't fit
410 GB               at 512 dims, int8 — fits on one node
```

Everything else you can reason to from those.
