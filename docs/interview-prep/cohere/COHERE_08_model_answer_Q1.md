# Model Answer — Q1, Enterprise AI Assistant

> **Don't read this until you've attempted Q1 yourself.**
>
> Reading a good answer and producing one feel identical while you're reading, and completely different in front of a whiteboard. The gap between recognising the right answer and generating it only closes by generating it.
>
> Attempt first. Then come here and compare.

---

## The scenario this answers

- 12,000 employees, ~3,000 daily active
- 4 million documents: 2.5M SharePoint, 800K Google Drive, 200K Confluence, plus Slack
- ~40,000 document changes per day
- Financial services customer
- Deploys into **their VPC**, with **on-premises contracted within the year**
- Strict document-level permissions, internal audit function will want evidence
- Read-only Q&A for v1 — no agent actions
- Responsive feel wanted; first token within a couple of seconds
- International, with significant operations in **Japan and the Gulf**

---

## Phase 1 — Scoping (4-5 minutes, before drawing anything)

Their own tip sheet lists "Clarify the Problem" first, so this is explicitly graded. Don't skip it, and don't start solving while you're still asking.

### The questions

> *"Before I draw anything, let me make sure I understand the shape of the problem."*
>
> 1. *"How many employees will use this, and what daily-active number should I plan for?"*
> 2. *"How many documents are we ingesting, roughly, and across which systems?"*
> 3. *"How fast does that corpus change?"*
> 4. *"Where does this deploy — our SaaS, their VPC, on-premises, air-gapped?"*
> 5. *"Are there document-level permissions to enforce, or is everything readable by everyone?"*
> 6. *"Is this read-only Q&A, or do we need agents that take actions in other systems?"*
> 7. *"What's the latency expectation — should this feel instant, or is a few seconds acceptable?"*
> 8. *"And anything explicitly out of scope I shouldn't spend time on?"*

### Why each one earns its place

| Question | What it changes |
|---|---|
| Employees / DAU | Sizes query load — and usually reveals this isn't a scale problem |
| Corpus size & systems | Sizes the index and tells you which connectors you need |
| Change rate | Determines incremental sync design and freshness SLO |
| **Deployment** | **The Cohere question.** Rules out every managed SaaS component if it's on-prem or air-gapped |
| Permissions | The single biggest source of complexity in enterprise retrieval |
| Read-only vs agents | An agent loop is a much larger problem than Q&A — pin the scope |
| Latency | Shapes rerank depth, caching, and whether you stream |
| Out of scope | Stops you designing things nobody asked for |

**The deployment question is the one that signals you understand their business.** Most candidates never ask it. Ask it fourth or fifth so it doesn't seem rehearsed, but do ask it.

### Writing the answers down

Put a text box in the corner of the canvas labelled **Constraints** and record what you're told. Two reasons: it shows discipline, and it gives you something to point back at when you justify a choice twenty minutes later. *"I'm picking a self-hostable vector store because of the on-prem requirement here"* is much stronger when you can gesture at where they told you that.

---

## Phase 2 — Capacity (3-4 minutes, three numbers)

Do this on the board, round aggressively, and **stop when the numbers stop changing your design.** The arithmetic is seductive; cap it at five minutes.

> *"Let me get a sense of scale before I design anything.*
>
> *Three thousand daily actives at maybe ten questions a day is thirty thousand queries a day — call it a third of a QPS average, a few QPS at peak. So this isn't a throughput problem. Worth saying out loud, because it means I shouldn't spend the next twenty minutes designing for scale I don't have.*
>
> *Four million documents at roughly ten chunks each is forty million chunks. At 1024 dimensions in float32 that's about 164 gigabytes of raw vectors — budget maybe 220 once you add the HNSW graph, the ACL payloads and operational headroom. That fits on a single large memory-optimised node, so I'm not forced to shard.*
>
> *Ingestion is where it gets interesting. Most PDFs are native and parse in milliseconds, but maybe a fifth will be scanned — signed agreements, legacy compliance records — and those need OCR at seconds per page. Five hundred thousand scanned documents at ten pages each is around a hundred and seventy days of single-worker time. It parallelises cleanly on CPU though, so fifty workers brings it under four days.*
>
> *So the shape of this is: not a QPS problem. It's a quality, security and ingestion problem."*

**That last sentence is the highest-value thing in the whole phase.** It reframes the problem and tells the interviewer you sized it rather than assumed it.

---

## Phase 3 — Architecture walkthrough (~10 minutes)

> Before I draw anything, I'm going to put a box around the whole thing and label it **customer perimeter**. Everything lives inside it. You said VPC now, with on-prem in the contract within the year — which means every component I pick has to be something we can ship into their environment. No managed SaaS anywhere in this design. That constraint does more work than anything else I'll say today.
>
> Inside that, there are two flows: an ingestion flow that gets four million documents into a searchable state, and a query flow where someone asks a question and gets a grounded answer. I'll do the query path first because it's user-facing, then come back to ingestion — which, as we established, is where the actual difficulty lives.
>
> **Query path.** An employee asks a question, from a web UI or eventually from inside Slack since that's where they already are. It hits a gateway, which does TLS termination, authentication, rate limiting and routing. I'd use something self-hostable — Envoy or Kong — rather than a managed API gateway, same perimeter reason. And it's earning its place, not just ceremony: everything behind it is GPU-backed, and a GPU is the most expensive thing you could let an unauthenticated request touch. Rejecting at the edge is worth real money here.
>
> Behind the gateway sits an orchestrator. Its first job is identity — it calls an identity service to resolve this user into their full principal set. Their own ID, plus every group and role they belong to, expanded transitively, because enterprise groups nest. That syncs from the customer's directory, Active Directory or Entra. I'd cache the expansion aggressively with event-driven invalidation, because walking a deep group tree on every query would hurt.
>
> Then the orchestrator calls retrieval with the question and that principal set. Retrieval does the two-stage thing — hybrid first stage for recall, permission filtering, cross-encoder rerank for precision, top eight chunks out. I can go deeper there if it's useful.
>
> Those chunks get assembled into a prompt with their source metadata, plus instructions to answer only from the provided context and to say so when the answer isn't there. Generation runs, we stream tokens back, and citations resolve to links the user can click to verify. For a regulated customer the citation isn't a nice-to-have — it's how their audit function trusts the system at all.
>
> One thing I'd log on every query: user, query hash, which chunks were returned, which were **denied** by the ACL filter, and the ACL version at the time. That's the audit trail their compliance team will ask for, and it's far easier to build now than to retrofit.
>
> **Now ingestion, the harder half.**
>
> Connectors, one per source system. Each does an initial full crawl then switches to incremental sync — change notifications where the source supports webhooks, polling where it doesn't. They all rate-limit aggressively, so I'd expect to be throttled and design for it rather than be surprised by it.
>
> Slack is worth calling out as a different shape. It isn't documents, it's millions of short messages, and a single message is usually meaningless out of context. I'd chunk by thread rather than by message, and I'd treat it as a lower-priority corpus initially, because the signal-to-noise is much worse than a curated Confluence space.
>
> Everything lands on a work queue partitioned per tenant and per source, with incremental updates prioritised above backfill — so one customer's bulk import can't starve everyone else's live updates.
>
> Then the pipeline. Fetch, dedupe on content hash so we skip unchanged documents, then parse — and parsing is where the real cost is. Most PDFs are native, with a text layer, and extract in milliseconds. But roughly a fifth will be scanned — signed contracts, legacy compliance records — and those need OCR at seconds per page. I'd detect rather than guess: attempt text extraction, and if almost nothing comes back, route it to OCR.
>
> On the numbers we did, that scanned backlog is around a hundred and seventy days of single-worker time. It parallelises cleanly onto CPU workers, so it doesn't compete with our GPUs, and fifty workers brings it under four days. But the more important consequence is a product decision: **I'd stage the rollout.** Index Confluence, Slack and the native PDFs first so the system is genuinely useful within hours, and let the scanned backlog fill in behind it over the following days. Much better than nothing working for a week.
>
> After parsing: chunk, structure-aware rather than fixed-size, keeping tables and code blocks intact because splitting a table destroys it entirely. Then — and this is the step people forget — capture the document's ACL from the source system and stamp it onto every chunk with a version number. **That's what makes permission-filtered retrieval possible later.** Skip it at ingestion and you cannot add it afterwards without reindexing everything.
>
> Then embed, batched on GPU, and upsert into both the vector index and the BM25 index.
>
> One thing I'd run as a separate, faster loop: **ACL synchronisation.** Document content changes slowly. Permissions change constantly — someone leaves a team, a folder gets reshared — and they matter more, because sync lag is literally a window during which someone can retrieve something they shouldn't. So permissions sync on a tighter cycle than content, with an SLO measured in minutes.
>
> **Underneath all of it, model serving.** Embedding, reranking and generation all run on GPUs inside the perimeter. They have quite different profiles — bulk embedding during ingestion is throughput work that can run overnight, query-time embedding is a single tiny request, reranking is a medium batch per query, generation is the expensive one. The thing I'd flag is that bulk ingestion and interactive queries compete for the same GPUs. A customer onboarding four million documents will starve live traffic if they share a pool, so either separate the pools or schedule bulk work off-peak with hard priority for interactive requests.
>
> Storage: Postgres for document metadata and job state, the two indexes for retrieval, object storage for raw documents — S3 in the VPC deployment, MinIO or equivalent on-prem.
>
> And one thing given they operate in Japan and the Gulf: the content isn't all English. I'd want a multilingual embedding model, per-language analysers on the BM25 side, and non-English queries represented in the golden set. Cross-lingual retrieval — someone asking in English about a Japanese document — is a real requirement and it's easy to break without noticing.
>
> That's the shape. Happy to go deeper on retrieval, ingestion, or the permission model, whichever's most useful.

### What's doing the work

- **The perimeter box is the first sentence**, not a footnote — with the reason attached. It reframes every later choice as constrained rather than arbitrary, and costs three seconds.
- **It uses their numbers back at them.** Japan and the Gulf, the on-prem clause, four million documents. Nothing signals listening better than specifics instead of generics.
- **Slack gets called out as different.** You were given four sources and one isn't document-shaped. Noticing that unprompted separates thinking from pattern-matching.
- **The OCR arithmetic becomes a product decision.** Capacity work that doesn't change what you build is showing off; capacity work that produces a rollout plan is engineering.
- **Ingestion gets equal billing**, because you said it was the hard part. Saying that and then drawing only the query path is a contradiction they'll spot.
- **It ends by handing over**, leaving three visible threads and letting them pick — so the deep dive starts on prepared ground.

---

## Phase 4 — Retrieval deep dive (~8 minutes)

> Let me go deeper on retrieval. I'll cover what it's doing, the one decision I'd defend hardest, and where I think it breaks.
>
> The retrieval service has a single job: given a question and a user, return the handful of passages most likely to answer it, restricted to what that specific user is allowed to see. Both halves of that matter, and the restriction is the harder one.
>
> So, the flow. A question arrives with the user's identity attached. The first thing I'd do is query understanding — rewriting and expansion. People ask things like "what about parental leave" with no verb and no context, and a rewrite step turns that into something actually retrievable. It's cheap and it lifts recall measurably.
>
> Then stage one, which is about recall. I run two retrievers in parallel. A dense one — embed the query, approximate nearest neighbour search over the vector index. And a lexical one, BM25 over the same corpus. I run both because **they fail in opposite directions**. The embedding model understands meaning but has never seen a contract number like SOW-2024-118 and has no idea what it is. BM25 matches that exactly, but would completely miss "how do I get money back for a flight" against a document titled "Travel Reimbursement Policy." Enterprise users search for both kinds of thing constantly, so covering only one leaves a real hole.
>
> That gives me two ranked lists on incompatible score scales, so I fuse them with reciprocal rank fusion, which discards the scores and votes on position instead. Out of that I take around 600 candidates.
>
> Then permissions — and I'll come back to why it happens *here* rather than during the search. I intersect each candidate's stored ACL against the user's resolved principal set: their user ID plus every group and role they belong to, transitively. The survivors, call it 150, go to stage two.
>
> Stage two is about precision. A cross-encoder reranks those 150 against the query and I take the top 8. Those go into the prompt with source metadata and grounding instructions, and the answer streams back with citations.
>
> **The decision I'd defend hardest there is the two stages, and the defence is arithmetic rather than taste.** A cross-encoder takes the query and document together as one input, so attention runs across both. It picks up things a bi-encoder structurally cannot — negation, qualification, whether a document actually *answers* the question rather than merely being on-topic. It's substantially more accurate. But nothing can be precomputed, because the score depends on the specific pairing. So scoring 40 million chunks means 40 million forward passes — roughly eleven hours, per query. Scoring 150 takes fifty milliseconds. That gap is the entire reason for the architecture. Stage one is a fast wide net whose only job is not to lose the answer, and I measure it on recall. Stage two is a slow precise judge whose job is to find it in the pile, and I measure that on NDCG. Different jobs, different metrics.
>
> **Two things here are genuinely hard.**
>
> First, permissions fight the index. The clean answer is to push the ACL check into the search itself so you never consider a chunk the user can't see. But a user's principal set might be fifty groups, and they might be entitled to only two percent of the corpus — and when a filter is that selective, HNSW has to traverse far more of the graph to find k surviving results, so latency degrades badly. What I'd actually build is a split. Cheap coarse filters — tenant ID, language — get pushed into the search, where they're nearly free. The expensive selective principal check runs afterwards on a bounded candidate set, which is why I over-fetch 600 to end up with 150. If someone's access is narrow enough that I come up short, I retry with a larger multiplier. So it isn't pre versus post — it's which filter goes where.
>
> Second, and this worries me more: **stage-one failures are silent.** If the right chunk never enters the candidate set, nothing errors. The reranker faithfully reorders what it was handed, the model writes a fluent confident answer from the wrong evidence, and the user has no way to know. You can't debug that by looking at the system — you can only catch it by measuring. So I'd want a golden set of a few hundred labelled questions from day one, recall@k tracked in CI, and any change to chunking or the embedding model regression-tested against it before it ships.
>
> **The trade-off I'd expect to keep revisiting is rerank depth.** Going deeper — 500 candidates rather than 150 — improves the odds the right chunk surfaces, but costs GPU and latency roughly linearly. And it's coupled to stage one: the better my stage-one recall, the shallower I can afford to rerank. So I wouldn't fix those numbers up front. I'd tune both against the same golden set and let the data say where the knee is.
>
> If I'm honest about what I'd get wrong first — I'd probably ship a chunking strategy that's too naive and then discover from the evals that tables and multi-page contracts retrieve badly. That's what I'd expect to iterate on most.

### What's doing the work

- **The opening two sentences signpost the shape**, then state the job in one line containing both hard constraints. The interviewer can now follow rather than wait.
- **Every claim carries its mechanism.** Not "I'd use hybrid search" but "because they fail in opposite directions, and here are two examples." That second clause is the whole difference between a junior and senior answer.
- **The arithmetic is load-bearing.** Eleven hours versus fifty milliseconds converts "two stages is a good pattern" into "two stages is forced." Numbers that *compel* a decision beat numbers that merely describe one.
- **The hard parts are volunteered, not extracted.** Offering failure modes unprompted signals you've run something like this rather than read about it.
- **It ends on uncertainty.** "What I'd get wrong first" is confident enough to be honest, and hands the interviewer a follow-up thread you're already prepared for.

---

## The five-beat structure (reusable for any deep dive)

```
1. What is this component FOR?        one sentence, its job
2. Walk the happy path                in detail, end to end
3. The key design decision + why      the thing you'd defend
4. What's hard / where it breaks      the honest part
5. The trade-off you'd revisit        shows you know it isn't settled
```

Most candidates only do step 2 — they narrate mechanics and stop. **Steps 3, 4 and 5 are where the signal is.**

Opening line that commits you to hitting them:

> *"Let me go deeper on X. I'll cover what it's doing, the one decision I'd defend hardest, and where I think it breaks."*

---

## Timing check

| Phase | Target | Cumulative |
|---|---|---|
| Scoping | 4-5 min | 5 |
| Capacity | 3-4 min | 9 |
| Architecture | 10-12 min | 21 |
| Deep dive | 8-10 min | 30 |
| Trade-offs / what breaks / week-1 | 4-5 min | 34 |

If you're past ten minutes and still doing arithmetic, you've overspent. The capacity phase is the one that runs long, every time.
