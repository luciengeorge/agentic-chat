# RAG Fundamentals — From First Principles

> You said conceptually familiar but not hands-on. This doc closes that gap. By the end you should be able to design a retrieval system and defend every component.
>
> Read this before the interview spine. Everything else assumes it.

---

## 0. Acronym glossary — read this first

The field is drowning in acronyms. Here they all are in one place, in plain English. Come back here whenever one trips you up.

### ANN — Approximate Nearest Neighbour

**The problem:** you have 40 million document vectors and need the ones closest to your query vector. Comparing against all 40 million (called **exact** or **brute-force** search) is accurate but far too slow.

**ANN** uses a clever data structure to find *almost* the closest ones, dramatically faster. You might miss one or two of the true top 100, but you do it in 10ms instead of 30 seconds.

> **Analogy.** Finding the nearest coffee shop. *Exact:* measure walking distance to every coffee shop in the city, sort, pick the closest — correct, takes all afternoon. *Approximate:* check your neighbourhood, expand outward until you find something good. You might miss one 10 metres closer across a park. You found good coffee in three seconds.

The word **approximate** is the point: you knowingly trade a sliver of accuracy for an enormous speedup. The two common algorithms are **HNSW** (a graph you hop through toward the query) and **IVF** (buckets, search only the nearby ones). Both give you a dial between accuracy and latency. Details in §3.

### ACL — Access Control List

**The list of who's allowed to access a thing.** Every SharePoint file, Google Doc and Slack channel has one:

```
File: "Salary Review 2026.xlsx"
Who can read it:
  • group "HR"
  • cfo@company.com
  • role "executive"
Everyone else: no access
```

**Why it dominates enterprise search:** your index is a *copy* of the content. Copy the text but not the ACL and you've built a machine that ignores every permission your customer configured — an intern asks an innocent question and gets the salary spreadsheet summarised back.

Related term: **principal** — any identity an ACL can name (a user, a group, or a role). "Resolving a user's principals" means expanding them into the full set of groups and roles they belong to. Details in §10.

### BM25 — keyword search, the old-fashioned kind

Stands for "Best Matching 25" — the 25th variant in a series of 1990s research experiments. **The name means nothing; don't try to decode it.**

It's the classic **keyword** ranking algorithm — what Elasticsearch does by default, what search did before neural networks. You search `parental leave policy`; it finds documents containing those actual words, scoring higher when:

- the word appears **more often** in the document
- the word is **rare across the corpus** — "parental" is distinctive, "the" is worthless
- the document is **short** — three matches in a title beats three matches buried in a 10,000-word manual

**Great at:** exact strings. Error code `E4021`. Contract `SOW-2024-118`. Surnames. Part numbers.

**Terrible at:** meaning. Search *"how do I get money back for a flight"* and BM25 completely misses *"Travel Reimbursement Policy"* — almost no shared words.

That's the **exact mirror image of embeddings**, which are great at meaning and hopeless at exact identifiers (an embedding model has never seen `SOW-2024-118` and has no idea what it is). Which is why you run both — see §6.

### RRF — Reciprocal Rank Fusion

**The problem:** you ran vector search *and* BM25. Two ranked lists. You need one.

Adding the scores doesn't work — they're on incompatible scales. Cosine similarity runs 0–1; BM25 might return 4.2 or 18.7 depending on corpus and query length.

**RRF's trick: discard the scores, use only the positions.**

```
RRF score  =  sum across each search of   1 / (k + rank)      (k is conventionally 60)
```

Worked example, searching "parental leave":

```
Vector search:          BM25:
  1. doc_A                1. doc_C
  2. doc_B                2. doc_A
  3. doc_C                3. doc_D

doc_A:  1/(60+1) + 1/(60+2)  =  0.0325   ← high in both
doc_C:  1/(60+3) + 1/(60+1)  =  0.0323   ← high in both
doc_B:  1/(60+2) +     0     =  0.0161   ← only vector found it
doc_D:      0    + 1/(60+3)  =  0.0159   ← only BM25 found it

Final:  doc_A, doc_C, doc_B, doc_D
```

It's a **voting system**. Documents both retrievers liked rise to the top; documents only one found still make the list, lower down. `k=60` flattens the gap between rank 1 and 2 so one confident retriever can't steamroll the other — the value is empirical and became convention.

### How the four fit together

```
Query: "can I expense a business class flight?"
         │
         ├──► embed query ──► ANN search over vector index
         │                     (semantic matches, filtered by ACL)
         │                          ↓ ranked list 1
         │
         └──► BM25 over text index
                               (exact keyword matches, filtered by ACL)
                                    ↓ ranked list 2

                     RRF fuses the two lists
                                    ↓
                          ~150 candidates
                                    ↓
                      cross-encoder reranks
                                    ↓
                           top 8 → prompt
```

- **ACL** decides what you're allowed to look at
- **ANN** makes searching millions of vectors fast enough to be possible
- **BM25** catches exact matches embeddings miss
- **RRF** merges the two lists without needing comparable scores

### The rest, briefly

| Acronym | Expansion | One-line meaning |
|---|---|---|
| **RAG** | Retrieval-Augmented Generation | Fetch relevant passages, put them in the prompt, generate a grounded answer |
| **LLM** | Large Language Model | The generative model — Command, in Cohere's stack |
| **HNSW** | Hierarchical Navigable Small World | The most common ANN algorithm — a graph you hop through |
| **IVF** | Inverted File Index | The other ANN family — bucket the space, search nearby buckets |
| **PQ** | Product Quantisation | Compression technique often paired with IVF |
| **MRL** | Matryoshka Representation Learning | Training so a vector's first N dimensions work standalone — §2b |
| **RBAC** | Role-Based Access Control | Permissions granted via roles rather than per-user |
| **NDCG** | Normalised Discounted Cumulative Gain | The standard search-quality metric — §8 |
| **MRR** | Mean Reciprocal Rank | Rewards putting the right answer first — §8 |
| **CDC** | Change Data Capture | Streaming every DB change as an event, for keeping indexes in sync |
| **OCR** | Optical Character Recognition | Turning scanned page images into text |
| **VPC** | Virtual Private Cloud | An isolated slice of a cloud provider that belongs to one customer |
| **KV cache** | Key-Value cache | Transformer inference memory that makes each next token cheaper |
| **LoRA** | Low-Rank Adaptation | Lightweight fine-tuning via small add-on weights |

---

## 1. The problem RAG solves

An LLM like Command knows what was in its training data. It does **not** know:

- Your company's internal documents
- Anything that happened after its training cutoff
- Your customer's specific contract terms
- Which of your 40,000 Confluence pages answers this question

Two naive fixes, both bad:

**"Just fine-tune the model on our documents."** Expensive, slow, has to be redone every time a document changes, and the model still can't cite sources or respect permissions. Fine-tuning teaches *style and behaviour*; it's a poor mechanism for *facts*.

**"Just put all the documents in the prompt."** Context windows are finite (even long ones), cost scales with tokens, and models get measurably worse at finding the relevant needle when the haystack is huge ("lost in the middle"). You can't fit 40,000 pages in a prompt, and even if you could, you shouldn't.

**RAG is the third way:** at query time, find the handful of passages that are actually relevant, put *those* in the prompt, and let the model answer grounded in them.

```
User question
     ↓
[ RETRIEVE ]  find the ~10 most relevant passages from a corpus of millions
     ↓
[ AUGMENT ]   build a prompt containing those passages + the question
     ↓
[ GENERATE ]  LLM answers, grounded in the provided passages
     ↓
Answer + citations
```

The retrieval step is where nearly all the engineering difficulty lives. The generation step is mostly "call the model."

---

## 2. Embeddings — what they actually are

An **embedding** is a list of numbers (a vector) that represents the *meaning* of a piece of text. Cohere's Embed model takes text in and produces, say, a 1024-dimensional vector out. (Dimension is a choice, not a fixed property — see §2b.)

```
"the cat sat on the mat"     →  [0.021, -0.153, 0.442, ..., 0.087]   (1024 numbers)
"a feline rested on a rug"   →  [0.019, -0.148, 0.451, ..., 0.091]   (very similar!)
"quarterly revenue forecast" →  [-0.312, 0.664, -0.028, ..., 0.203]  (very different)
```

The magic property: **texts with similar meanings produce vectors that are close together in space.** Not similar *words* — similar *meaning*. "Feline rested on a rug" and "cat sat on the mat" share almost no words, but their embeddings are nearly identical.

**How do you measure "close"?** Usually **cosine similarity** — the cosine of the angle between two vectors. Ranges from -1 (opposite) to 1 (identical direction). In practice you'll see values like 0.85 for "very relevant" and 0.3 for "unrelated."

**Why this matters:** it lets you search by meaning rather than keyword. A user asking "how do I expense a flight?" can match a document titled "Travel Reimbursement Policy" even though they share zero words.

**The key operational fact:** embeddings are computed once at ingestion time and stored. You don't re-embed your corpus on every query — you embed the *query* and compare it against pre-computed document embeddings. That's what makes it fast.

---

## 2b. Choosing the embedding dimension

Yes, the length matters — it's one of the few genuinely tunable knobs in a retrieval system, and it's a direct **quality vs cost** trade-off.

### What dimension buys you

More dimensions means more capacity to encode distinctions. A 256-dim vector has to compress "everything this passage means" into 256 numbers; a 1536-dim vector has six times the room. In practice, higher dimensions give modestly better retrieval quality, with **sharply diminishing returns** — going 256 → 1024 helps noticeably, 1024 → 1536 helps a little, and beyond that you're mostly paying for nothing.

### What dimension costs you

Everything downstream scales linearly with it:

```
index size  =  num_chunks  ×  dimensions  ×  bytes_per_number
```

For a 40M-chunk corpus at float32 (4 bytes):

| Dimensions | Raw vector storage |
|---|---|
| 256 | 41 GB |
| 512 | 82 GB |
| 1024 | 164 GB |
| 1536 | 246 GB |

That's the difference between "fits in RAM on one large node" and "needs a sharded cluster." Search latency also scales with dimension, since every distance computation touches every dimension.

### What else lives in RAM besides the vectors

Raw vector size isn't your whole memory bill. Three other things add to it.

**1. The HNSW graph itself.** HNSW (covered properly in §3) doesn't just store vectors — it stores a *navigable graph* over them, where each vector is a node linked to its nearest neighbours. Those links are what let search hop toward the answer instead of scanning everything. They cost memory.

The size is governed by `M`, the max links per node per layer. Layer 0 (which holds every node) typically gets `2M` links; upper layers are exponentially sparser. A decent approximation:

```
graph bytes per vector  ≈  M × 2 × 4 bytes   (4 bytes per node ID)

M = 16  →  ~128 bytes/vector
M = 32  →  ~256 bytes/vector
M = 64  →  ~512 bytes/vector
```

**The non-obvious part: this is a bigger relative penalty for small vectors.** At M=32:

| Dimensions | Vector bytes | Graph bytes | Graph as % of vector |
|---|---|---|---|
| 256 | 1,024 | 256 | **25%** |
| 512 | 2,048 | 256 | 12% |
| 1024 | 4,096 | 256 | 6% |
| 1536 | 6,144 | 256 | 4% |

So some of what you save by dropping from 1024 to 256 gets clawed back by the graph, which doesn't shrink with dimension. Worth knowing if an interviewer pushes on the memory math.

**2. Payload.** Every chunk carries metadata: `chunk_id`, `source_doc_id`, `tenant_id`, `acl_version`, and crucially `allowed_principals[]` — which can be a long list. A document shared with 20 groups carries 20 principal IDs. At ~20 bytes each that's 400 bytes per chunk, which can rival the graph.

**3. Operational headroom.** Allocator fragmentation, query-time working memory, and build-time spikes (HNSW construction peaks well above steady state). Deleted vectors also leave tombstones until you compact.

**Practical sizing rule:** budget **1.3–2× raw vector size** for total RAM, where the multiplier is higher for low-dimensional vectors and ACL-heavy payloads. Don't quote 1.5× as though it's a property of HNSW — it isn't. It's a blended rule of thumb across graph, payload, and headroom.

Applying that to the table above: 1024 dimensions at 164 GB raw lands somewhere around **210–250 GB** in practice.

### The thing that changed: Matryoshka embeddings

You used to pick a model and inherit its dimension. Not any more.

**The name** comes from Matryoshka dolls — Russian nesting dolls, where each doll contains a smaller complete doll inside it. That's exactly the property: a 1536-dim vector contains a complete, usable 1024-dim vector inside it, which contains a complete 512-dim vector, which contains a complete 256-dim vector.

```
[■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■]  full 1536 dims
[■■■■■■■■■■■■■■■■■■■■■]                first 1024 — still works
[■■■■■■■■■■■]                          first 512 — still works
[■■■■■]                                first 256 — still works
```

**Why this isn't normally possible.** In an ordinary embedding, information is spread arbitrarily across all dimensions. There's no reason dimension 3 matters more than dimension 900 — the model had no incentive to organise it that way. Chop off the last 75% and you haven't got a lower-resolution embedding, you've got a broken one. The surviving dimensions were never meant to stand alone.

**What MRL changes is the training objective.** Instead of only optimising the full 1536-dim output, you simultaneously optimise the first 256, the first 512, the first 1024, *and* the full vector — each with its own loss term. The model is forced to make every prefix work as a standalone embedding. The only way it can satisfy that is to pack the most important, most general signal into the early dimensions and use later dimensions for finer distinctions.

Hence: **coarse-to-fine, front-loaded.** Truncating throws away nuance, not meaning.

**Cohere's Embed v4 supports exactly this** — output dimensions of **256, 512, 1024, or 1536**, selected with an `output_dimension` parameter. Default is 1536.

### Why it matters practically

**1. Dimension becomes a runtime decision, not a model-selection decision.** This is the big one. Normally, changing your embedding dimension means re-embedding your entire corpus — for 40M chunks that's hours of GPU time and a dual-index migration. With MRL you just truncate the vectors you already have. Changing your mind is nearly free.

**2. One index, multiple resolutions.** Store at full 1536. Serve a latency-sensitive typeahead path from the truncated 256-dim version and the main search path from 1024. Same underlying vectors.

**3. Adaptive retrieval** — the same coarse-then-fine trick as binary quantisation, but with dimensions:

```
40M chunks
   ↓  search using first 256 dims only   (6× less computation per comparison)
2,000 candidates
   ↓  rescore using full 1536 dims
100 candidates
   ↓  cross-encoder rerank
8 chunks → prompt
```

You'll notice this is structurally identical to the binary-quantisation cascade below. That's not a coincidence — **cheap-and-approximate first, expensive-and-exact on the survivors** is the governing pattern of the whole retrieval stack. Once you see it, every layer of a RAG system is the same idea at a different scale.

### The interview-ready sentence

> *"Embed v4 uses Matryoshka representation learning, so the vector is nested — the first 256 dimensions are themselves a valid embedding. That means I can store at full resolution and truncate at query time rather than committing to a dimension at ingestion, and it opens up adaptive retrieval: search cheaply on the truncated prefix, then rescore the shortlist at full resolution."*

### The other lever: quantisation

Dimension count is one axis; **bytes per number** is the other.

An embedding is a list of numbers. Quantisation asks: *how precisely do you actually need to store each one?*

```
float32 (4 bytes):  0.21384726...    very precise
float16 (2 bytes):  0.2138           slightly rounded
int8    (1 byte):   0.21             rounded to 1 of 256 values
binary  (1 bit):    1                just "is it positive?"
```

**The insight:** for *search*, you often don't need much precision. You're asking "which vectors point in roughly the same direction as my query?" Small rounding errors rarely change the answer.

| Precision | Bytes/dim | 40M chunks @ 1024d | Quality impact |
|---|---|---|---|
| float32 | 4 | 164 GB | baseline |
| float16 | 2 | 82 GB | negligible |
| int8 | 1 | 41 GB | small — usually within noise, basically free |
| binary (1 bit) | 0.125 | 5 GB | significant *on its own* — but see below |

**Binary on its own is too lossy:**

```
Original: [ 0.21, -0.53,  0.44, -0.08, ... ]
Binary:   [ 1,     0,     1,     0,    ... ]   ← just the sign
```

You've thrown away nearly everything. 32× smaller, noticeably worse results.

**So you pair it with rescoring.** Keep *both* representations — binary in RAM (tiny), full-precision on disk (cheap). Then:

1. Query arrives → compare against **binary** vectors. Absurdly fast: comparing binary vectors is XOR-and-count-bits, which CPUs do in nanoseconds.
2. Grab a **generous** shortlist — top 1,000 rather than top 100, because binary is imprecise and you want slack.
3. Fetch those 1,000 **full-precision** vectors from disk.
4. Rescore properly → real top 100.
5. Hand to the reranker.

Binary is good enough to narrow 40M → 1,000. You only need real precision for that last 1,000, and fetching 1,000 vectors is nothing.

**Why this fits your design:** you're already doing coarse-then-fine with two-stage retrieval. This bolts an even coarser stage onto the front:

```
40M chunks
   ↓  binary search          (nanoseconds, ~5 GB RAM)
1,000 candidates
   ↓  full-precision rescore (disk fetch)
100 candidates
   ↓  cross-encoder rerank   (GPU)
8 chunks → prompt
```

Each stage is cheaper per item and looks at more items than the one after it. Same pattern, applied three times instead of two.

### How to actually choose — the concrete workflow

**Step 1 — build a golden set.** Write ~200 realistic questions. For each, label the chunks that genuinely answer it.

```
Q: "What's our parental leave policy?"
Correct chunks: [hr_handbook_ch3_p2, benefits_faq_c14, policy_memo_2026_c01]

Q: "Who approves expenses over £5000?"
Correct chunks: [finance_policy_c22]

... × 200
```

Tedious, and the highest-value thing you can build. Everything else depends on it.

**Step 2 — pick a target.** Something like *"95% recall@100"* — meaning *for 95% of questions, at least the right chunk lands in the top 100 candidates we hand to the reranker.*

**Step 3 — run the experiment.** Embed the corpus at each candidate dimension, run all 200 questions, count hits.

| Dimension | Recall@100 | Index size | Verdict |
|---|---|---|---|
| 256 | 89% | 61 GB | misses target |
| 512 | 94% | 123 GB | just misses |
| **1024** | **96%** | **246 GB** | **hits target** ✓ |
| 1536 | 96.5% | 368 GB | +0.5% for +50% memory — not worth it |

**Step 4 — read the knee.** 256 → 512 buys 5 points of recall for 2× memory: good trade. 1024 → 1536 buys half a point for another 50%: bad trade.

**So you pick 1024** — not because it's a round number, but because it's the smallest dimension that clears the bar.

Note that if your target had been 90%, **256 would have been fine** and you'd have saved 185 GB. The target drives the answer, which is why step 2 matters.

**Step 5 — then quantise** if memory is still the binding constraint, and **revisit as the corpus grows.**

The general rule: **corpus size pushes you down, quality requirements push you up.** A 100K-chunk internal wiki can afford 1536 dimensions at float32 and never think about it. A 500M-chunk archive needs 256 dimensions with int8 quantisation and binary rescoring, and you'll fight for every point of recall.

### The interview line

> *"I'd treat embedding dimension as a tunable rather than a given. Embed v4 supports Matryoshka truncation at 256, 512, 1024 and 1536, so I'd embed at full resolution, then measure recall@k at each dimension against a golden set and pick the smallest one that hits our quality bar. At 40 million chunks the difference between 256 and 1536 is roughly 60 GB versus 370 GB of index — that's the difference between one node and a sharded cluster, so it's worth the evaluation effort. If memory were still the binding constraint I'd add int8 quantisation, or binary vectors with full-precision rescoring on the shortlist."*

That answer demonstrates you know it's a dial, you know how to set it empirically, you can quantify the cost, and you know the escape hatches. Strong signal.

---

## 3. Vector search — finding the needle fast

You have 10 million chunks, each with a 1024-dimensional embedding. A user asks a question. You embed the question. Now you need the 100 closest vectors out of 10 million.

**The naive approach** — compute cosine similarity against all 10 million, sort, take top 100 — is called *exact / brute-force / flat* search. It's perfectly accurate and far too slow at scale (though fine below ~100K vectors, which is worth knowing — don't over-engineer a small corpus).

**The real approach: ANN — Approximate Nearest Neighbour.** Trade a tiny bit of accuracy for orders-of-magnitude speedup. Two dominant algorithm families:

**HNSW (Hierarchical Navigable Small World)** — builds a multi-layer graph where each node links to its nearest neighbours. Search starts at a sparse top layer and navigates down, greedily hopping toward the query. Fast, high recall, memory-hungry. The most common default.

**IVF (Inverted File Index)** — clusters vectors into buckets (Voronoi cells). At query time, search only the few nearest buckets rather than everything. Lower memory, tunable, slightly lower recall. Often combined with **PQ (Product Quantisation)** to compress vectors and cut memory further.

**The tuning knob to know:** ANN gives you a **recall vs latency** dial. HNSW's `ef_search` parameter, IVF's `nprobe` — turn them up for better recall and worse latency, down for the reverse. In an interview, saying *"I'd tune ef_search to hit our recall target at acceptable p99"* shows you know it's a dial, not a fixed thing.

**Vector stores you can name** (all self-hostable, which matters at Cohere):

| Store | Notes |
|---|---|
| **pgvector** | Postgres extension. Great when you already run Postgres and your corpus is modest. Metadata filtering is just SQL, which is a big deal for permissions. |
| **Qdrant** | Purpose-built, Rust, good filtering support, easy self-host |
| **Weaviate** | Purpose-built, built-in hybrid search |
| **Milvus** | Purpose-built, scales large, heavier to operate |
| **Elasticsearch / OpenSearch** | Has vector support *plus* mature BM25 — attractive when you want hybrid search in one system |

**Avoid naming Pinecone** in a Cohere interview unless you caveat it — it's SaaS-only and can't ship air-gapped.

---

## 4. Chunking — the underrated decision

You can't embed a 200-page PDF as one vector. Meaning gets averaged into mush, and you can't cite a specific passage. So you split documents into **chunks**.

**How big?** The classic range is 200–1000 tokens per chunk. The trade-off:

- **Small chunks** (~200 tokens): precise retrieval, tight citations, but may lack context. A chunk saying "this is capped at 15%" is useless without knowing what "this" is.
- **Large chunks** (~1000+ tokens): more self-contained context, but noisier retrieval (the relevant sentence is diluted by surrounding irrelevance) and you burn more prompt tokens.

**Strategies, roughly in order of sophistication:**

1. **Fixed-size** — every N tokens. Simple, dumb, splits mid-sentence.
2. **Fixed-size with overlap** — every N tokens with ~10-20% overlap between adjacent chunks, so a concept spanning a boundary appears whole in at least one chunk. Cheap fix, widely used.
3. **Structure-aware** — split on document structure: headings, paragraphs, sections, slide boundaries, table rows. Much better, requires a parser that understands the format. **This is what Cohere's Parse model is for.**
4. **Semantic chunking** — detect topic shifts (e.g. embedding similarity between adjacent sentences drops) and split there. Better coherence, more expensive to compute.
5. **Contextual retrieval** — prepend a short LLM-generated summary of the parent document to each chunk before embedding, so isolated chunks carry their context. Notably effective, notably expensive at ingestion.

**Things that break naive chunking** (good to mention — shows real-world thinking):
- **Tables** — split a table across chunks and it becomes meaningless. Keep tables whole or serialise them into text.
- **Code blocks** — same problem.
- **Slides** — one slide is often a natural chunk, but speaker notes matter too.
- **Spreadsheets** — rows vs sheets vs named ranges; genuinely hard.
- **Scanned PDFs** — need OCR before you can chunk at all.

**Interview-safe default:** *"I'd start with structure-aware chunking at roughly 500 tokens with 15% overlap, keeping tables and code blocks intact, and revisit based on retrieval evals."*

---

## 5. Two-stage retrieval — the single most important architecture idea

This is the thing Compass does and the thing you should propose.

### The problem with one-stage

Embedding search (bi-encoder) is **fast but blunt**. Query and document are embedded *independently*, so the model never gets to compare them directly — it just projects each into a shared space and hopes proximity means relevance. It's good at "roughly on-topic," less good at "actually answers this specific question."

### The fix: rerank the shortlist

A **cross-encoder** (Cohere's Rerank) takes the query and a candidate document **together** as one input and outputs a relevance score. Because it can attend across both, it's dramatically more accurate. The catch: you can't pre-compute anything. Scoring N documents means N forward passes at query time. Doing that for 10 million documents is impossible.

### Therefore: two stages

```
Query
  ↓
STAGE 1 — bi-encoder (Embed) + ANN search over 10M chunks
  ↓  cheap, ~10ms, optimised for RECALL
  Top 100-200 candidates
  ↓
STAGE 2 — cross-encoder (Rerank) scores each candidate against the query
  ↓  expensive per-item but only 100-200 items, ~50-100ms
  Top 5-10 chunks, precisely ranked
  ↓
Into the prompt
```

**The mental model:** stage 1 is a *fast, wide net* — its job is to make sure the right answer is somewhere in the top 200. Stage 2 is a *slow, precise judge* — its job is to find the right answer within those 200 and put it at position 1.

**Stage 1 optimises recall. Stage 2 optimises precision.** If stage 1 misses the correct chunk entirely, no amount of reranking saves you — which is why recall@100 is the metric that matters for stage 1.

Being able to say *"stage one is recall, stage two is precision, and they're measured differently"* is a strong signal.

---

## 6. Hybrid search — because semantics isn't everything

Vector search is bad at some things that keyword search is great at:

- **Exact identifiers** — "error code E4021", "contract SOW-2024-118", part numbers, ticket IDs
- **Rare proper nouns** the embedding model didn't see much in training
- **Exact phrase matching** when the user genuinely wants those words

**BM25** is the classic lexical ranking function (the thing Elasticsearch uses by default). It scores on term frequency and rarity — great at exact matches, blind to synonyms.

**Hybrid search** runs both and fuses the results. The standard fusion method is **Reciprocal Rank Fusion (RRF)**:

```
score(doc) = Σ over retrievers  1 / (k + rank_in_that_retriever)
```

with k typically 60. It's rank-based rather than score-based, so you don't have to normalise incompatible scoring scales. Simple and works well.

**Interview line:** *"I'd run hybrid retrieval — dense vector search for semantic matching plus BM25 for exact identifiers — and fuse with reciprocal rank fusion before reranking. Pure vector search fails badly on things like error codes and contract numbers, which enterprise users search for constantly."*

That's a very strong, very practical thing to volunteer.

---

## 7. Context assembly and generation

You've got your top 5-10 chunks. Now build the prompt.

**Things that matter:**

- **Ordering.** Models attend more to the beginning and end of context ("lost in the middle"). Put the highest-scored chunks at the extremes, not buried in the centre.
- **Token budget.** Decide how much of the context window goes to retrieved evidence vs conversation history vs system prompt. Enforce it — truncate or drop chunks rather than blowing the window.
- **Metadata inclusion.** Include source title, author, date, URL with each chunk. The model needs this to cite, and users need it to trust.
- **Instructions for grounding.** Explicitly instruct: answer only from the provided context; if the context doesn't contain the answer, say so.
- **Citation format.** Ask for structured citations (chunk IDs) that you can resolve back to source links in the UI.

**On streaming:** users expect tokens to appear as they're generated. Your API should stream (SSE or WebSocket). Note the ordering problem: you often want to show citations, but you only know the full citation set once generation completes. Common pattern is to stream the text and attach citations progressively or at the end.

---

## 8. Evaluation — how you know it works

If the interviewer asks "how do you know your RAG system is good?" — this is the answer. Measure retrieval and generation **separately**, because they fail for different reasons.

### Retrieval metrics

**Recall@k is the one to understand properly**, because it's the headline metric for stage 1.

The question it answers: *"Of the chunks that would actually have answered this question, how many did I manage to retrieve?"*

> User asks: *"What's our parental leave policy?"*
>
> In your corpus, **3 chunks** genuinely contain that answer — one in the HR handbook, one in a benefits FAQ, one in a policy update memo.
>
> You retrieve the **top 10**. Two of those three correct chunks are in there.
>
> **Recall@10 = 2/3 = 67%**

The `@k` just means *how deep did I look*. Recall@10 and Recall@100 are different numbers for the same system — retrieve more and you catch more. (Retrieve all 40 million and recall is trivially 100%, which is why the number is meaningless without the k.)

**Why it matters more than anything else in stage 1:** if the right chunk never enters your candidate set, nothing downstream can rescue you. The reranker can only reorder what it was handed. The model can only cite what it was shown. A stage-1 miss is a permanent, silent failure — the user gets a confident answer built on the wrong evidence, or an "I don't know" when the answer was sitting right there.

That's the whole reason stage 1 optimises recall and stage 2 optimises precision. Stage 1's only job is *don't lose the answer*. Stage 2's job is *find it in the pile*.

| Metric | What it measures |
|---|---|
| **Recall@k** | Of all the relevant chunks, what fraction appeared in the top k? The headline metric for stage 1. |
| **Precision@k** | Of the top k returned, what fraction were actually relevant? |
| **MRR** (Mean Reciprocal Rank) | 1/rank of the first relevant result, averaged. Rewards putting the right thing first. |
| **NDCG** | Discounted cumulative gain — handles graded relevance (very relevant vs somewhat) and position discounting. The standard IR metric. |

### Generation metrics

| Metric | What it measures |
|---|---|
| **Faithfulness / groundedness** | Is every claim in the answer supported by retrieved context? Catches hallucination. |
| **Answer relevance** | Does the answer actually address the question? |
| **Citation accuracy** | Do the cited sources actually support the cited claims? |

### How you actually run evals

- **Golden set** — a few hundred hand-curated (question, correct answer, correct source chunks) triples. The ground truth you regress against.
- **LLM-as-judge** — use a model to score faithfulness and relevance at scale. Cheaper than humans, noisier, needs calibration against human labels.
- **Online signals** — thumbs up/down, click-through on citations, "was this helpful", query reformulation rate (a user rephrasing means you failed).
- **Regression testing in CI** — when you change chunking, the embedding model, or the prompt, re-run the golden set and compare. Never ship a retrieval change without this.

**Interview line:** *"I'd measure retrieval and generation separately — recall@k and NDCG for retrieval, faithfulness and citation accuracy for generation — against a golden set of a few hundred labelled queries, run in CI so any change to chunking or prompting gets regression-tested."*

---

## 9. The failure modes (know these — they're the "what breaks" answer)

| Failure | Cause | Mitigation |
|---|---|---|
| **Retrieval miss** | Right chunk never made the top-k. Bad chunking, bad embeddings, or vocabulary mismatch. | Hybrid search, query expansion, better chunking, tune ANN recall |
| **Hallucination** | Model asserts things not in context | Strict grounding instructions, require citations, post-hoc faithfulness check, return "I don't know" |
| **Stale index** | Document changed, index didn't | Incremental sync, CDC from source systems, freshness SLO |
| **Permission leak** | Retrieved a chunk the user shouldn't see | ACL filtering at retrieval time (see next section) — the most serious failure |
| **Lost in the middle** | Relevant chunk buried in long context | Rerank hard, keep context tight, order strategically |
| **Context overflow** | Too many chunks, window exceeded | Enforce token budget, drop lowest-scored chunks |
| **Slow p99** | Reranking too many candidates, cold cache, GPU queueing | Cap rerank candidates, cache embeddings, batch inference |
| **Conflicting sources** | Two documents disagree (old policy vs new) | Recency boosting, surface the conflict, show dates in citations |

---

## 10. Permission-aware retrieval (the enterprise differentiator)

Covered in the North primer, but the mechanics belong here.

**At ingestion:** every chunk carries the ACL of its source document — typically a set of principal IDs.

```json
{
  "chunk_id": "doc_4821_chunk_07",
  "text": "Q3 revenue is forecast at...",
  "embedding": [0.021, -0.153, ...],
  "source_doc_id": "doc_4821",
  "source_system": "sharepoint",
  "allowed_principals": ["group:finance", "user:cfo@co", "role:exec"],
  "acl_version": 47,
  "updated_at": "2026-09-01T10:00:00Z"
}
```

**At query time:** resolve the user's full principal set (their user ID, all groups they belong to, all roles), then constrain the search.

**Three enforcement strategies:**

| Strategy | How | Trade-off |
|---|---|---|
| **Pre-filter** | Push the ACL predicate into the vector search — only consider chunks the user can see | Correct and safe, but can wreck ANN performance: if the filter is very selective, the graph traversal has to explore far more nodes to find k results |
| **Post-filter** | Retrieve top-k ignoring ACLs, then drop unauthorised ones | Fast search, but you may return far fewer than k results — worst case zero — and you've wasted work |
| **Hybrid / over-fetch** | Retrieve top-(k × multiplier), then filter, and retry with a bigger multiplier if you come up short | The pragmatic production answer |

**The hard parts worth mentioning:**

- **ACL freshness.** Someone's removed from a group at 9am; the index still says they can see the doc. Your ACL sync lag is a security window. Define an SLO for it (minutes, not hours) and drive it with change events from the source system where possible.
- **Group expansion.** Enterprise groups nest. Resolving "all principals for this user" can mean walking a deep tree in Active Directory. Cache aggressively, invalidate on change.
- **Deny rules.** Some systems have explicit denies that override allows. Set-membership logic gets fiddly.
- **The generated answer can leak too.** Even with correct retrieval, if a conversation has history, an earlier turn's context might persist. Scope context per-turn against current permissions.
- **Audit.** Log every retrieval with what was returned and what was denied. Regulated customers require it.

---

## 11. Agentic RAG — when retrieval isn't one-shot

North does agents, so know this extension.

**Plain RAG** is one-shot: embed query → retrieve → generate. Works for "what's our parental leave policy?"

**It fails** for questions that need multiple steps: *"Compare our Q3 performance against the targets we set in the January board deck, and tell me which regions missed."* One retrieval can't answer that — you need several, plus reasoning between them.

**Agentic RAG** puts the model in a loop with tools:

```
   ┌──────────────────────────────────────┐
   │                                      │
   ▼                                      │
[ Model plans ] → [ Calls a tool ] → [ Observes result ]
   │                                      │
   │  (search_docs, query_db, send_email, │
   │   get_calendar, update_crm, ...)     │
   │                                      │
   └── enough info? ──────────────────────┘
              │ yes
              ▼
        [ Final answer ]
```

**Engineering concerns this introduces:**

- **Loop termination.** Cap iterations (typically 5-10). Without a cap, a confused agent loops forever burning tokens.
- **Tool schemas.** Each tool needs a typed, documented interface the model can reliably call.
- **Error handling.** Tool fails — do you retry, tell the model, or abort? Usually: return the error *to the model* and let it adapt.
- **Latency.** Each loop iteration is a model call. Five iterations at 2s each is a 10-second wait. Stream intermediate progress so the user sees activity.
- **Permissions on actions, not just reads.** An agent that can *send email* or *update a CRM record* needs authorisation checks on every action, with the acting user's identity — not a service account with god-mode.
- **Human-in-the-loop.** For consequential actions (sending external email, moving money, deleting things), require explicit user approval. "Supervised autonomy" is Cohere's own framing.
- **Observability.** You need full traces of every step for debugging and audit. Agents fail in confusing ways and "it gave a weird answer" is undebuggable without the trace.

---

## 12. Self-check

Answer these out loud without notes, then mark yourself against the model answers below.

**The rule for marking:** an answer that states a fact but not the mechanism or cost behind it scores half. In the interview, every factual claim invites "why?" or "what's the trade-off?" — so an answer that stops one level short is an answer that will get pushed on.

### The questions

1. Why not just fine-tune instead of RAG?
2. What is an embedding, and what does cosine similarity measure?
3. How do you choose the embedding dimension, and what does doubling it cost you?
4. Why can't you use a cross-encoder over your whole corpus?
5. What does stage 1 optimise for, and what does stage 2 optimise for?
6. Why add BM25 when you already have semantic search?
7. Name three chunking strategies and a trade-off for each.
8. How do you enforce document permissions in a vector index, and what's the trade-off between pre- and post-filtering?
9. How do you measure whether retrieval is working, separately from generation?
10. Name four ways a RAG system fails in production.
11. What changes when you go from one-shot RAG to an agent loop?

---

### Model answers

**1. Why not fine-tune?**

Fine-tuning teaches **behaviour and style**, not facts — it's a poor mechanism for knowledge. And operationally it's untenable: you'd have to retrain every time a document is added, edited or deleted. You also lose two things enterprise needs — **citations** (a fine-tuned model can't tell you where an answer came from) and **per-user permissions** (the weights don't know who's asking).

**2. Embedding and cosine similarity**

An embedding is a vector representation of text, where texts with similar *meanings* land close together in space. Cosine similarity measures **the angle between two vectors** — that's the mechanism. We *interpret* it as semantic similarity because of how the model was trained to arrange meanings. Keep the mechanism and the interpretation distinct if someone probes.

**3. Choosing dimension**

It's a quality-vs-cost trade-off with **diminishing returns** — note that's not the same as uniformly marginal. 256→512 can be a real gain; 1024→1536 usually isn't.

*How you'd actually decide:* build a golden set, measure recall@k at each supported dimension, find the knee, pick **the smallest dimension that clears your target** — not the largest you can afford.

*What doubling costs:* everything scales linearly. 40M chunks at 1024 dims is ~164 GB of raw vectors; at 1536 it's ~246 GB. That can be the difference between one node and a sharded cluster. Search latency scales too, since every distance computation touches every dimension.

*The modern wrinkle:* with Matryoshka (Embed v4), dimension is a **runtime** decision, not a model-selection one. Embed at full resolution, truncate per use case.

**4. Why not cross-encode everything**

Because **nothing can be pre-computed.** That's the mechanism, and "too slow" without it is half an answer.

A bi-encoder computes document vectors once at ingestion; at query time it's one forward pass for the query plus cheap dot products. A cross-encoder's score depends on the specific **query-document pair**, so there's nothing to cache — you need one full transformer forward pass per candidate. For 40M chunks at ~1ms each, that's roughly **11 hours per query**. For 150 candidates batched on a GPU it's 50-100ms.

That arithmetic *is* the reason two stages exist. It's a hard constraint, not a design preference.

**5. What each stage optimises for**

- **Stage 1 optimises recall.** Its only job is *don't lose the answer*. Measured by recall@k.
- **Stage 2 optimises precision.** Its job is *find the right one in the pile*. Measured by NDCG or MRR.

Why this framing matters: they're tuned and measured differently, and it explains the failure mode — **if stage 1 misses the correct chunk, no amount of reranking recovers it.** A stage-1 miss is permanent and silent.

**6. Why BM25 alongside semantic search**

They **fail in opposite directions.** Embeddings understand meaning and are blind to exact identifiers — an embedding model has never seen `SOW-2024-118` and has no idea what it is. BM25 matches strings exactly and is blind to meaning — it'll miss "Travel Reimbursement Policy" for the query "how do I get money back for a flight."

Enterprise users search for error codes, contract numbers, part numbers and surnames constantly. You're not double-covering; you're covering two different holes. Fuse with RRF.

**7. Chunking strategies + trade-offs**

| Strategy | Trade-off |
|---|---|
| Fixed-size | Trivial to implement; splits mid-sentence and mid-table |
| Fixed + overlap | Cheap fix for boundary-spanning concepts; ~15% more storage |
| Structure-aware | Much better coherence; needs a parser that understands each format |
| Semantic (split on topic shift) | Best coherence; expensive to compute at ingestion |

Plus the general size trade-off: **small chunks give precise citations but lose context; large chunks carry context but dilute retrieval.** Interview-safe default: structure-aware at ~500 tokens with 15% overlap, tables and code kept intact, tuned against evals.

**8. Enforcing permissions — and the real trade-off**

Stamp `allowed_principals` onto every chunk at ingestion. At query time, resolve the user into their full transitive principal set and constrain the search.

The trade-off is genuinely two-sided:

- **Post-filter** — retrieve top-k ignoring ACLs, then drop unauthorised. Fast search, but you may return **far fewer than k**, worst case zero, and you wasted the work.
- **Pre-filter** — push the ACL predicate into the search. Correct, but it can **wreck ANN performance**: if only 0.1% of chunks pass the filter, the HNSW traversal has to explore vastly more of the graph to find k survivors, and latency blows up.

**The production answer is neither.** Over-fetch (top k×m), filter, retry with a larger multiplier if you come up short — plus cheap *non-selective* pre-filters like `tenant_id` pushed into the search, where they cost nothing.

And the invariant underneath all of it: **enforcement happens before generation.** Once an unauthorised chunk is in the prompt, no instruction reliably stops the model using it.

**9. Measuring retrieval separately from generation**

You need both halves:

*Retrieval:* recall@k (the headline for stage 1), precision@k, MRR, NDCG.

*Generation:* **faithfulness/groundedness** (is every claim supported by retrieved context?), **answer relevance** (does it address the question?), **citation accuracy** (do cited sources actually support the claims?).

*How you run it:* a golden set of a few hundred labelled (question, answer, correct-chunks) triples; LLM-as-judge for scale, calibrated against human labels; online signals like thumbs and query-reformulation rate; and **regression tests in CI** so no chunking or prompt change ships unmeasured.

Measuring them separately matters because they fail for different reasons and have different fixes. "It hallucinates" might be a retrieval miss or a generation failure — you can't tell without separate measurement.

**10. Four production failure modes**

Retrieval miss · hallucination · stale index · permission leak.

(Others worth having: lost-in-the-middle, context overflow, conflicting sources, slow p99.) **Permission leak is the highest severity** — it's a security incident, not a quality bug.

**11. What changes with an agent loop**

Name the concerns, don't gesture at them:

- **Loop termination** — iteration caps (5-10), timeouts, token budgets. A confused agent runs forever.
- **Tool schemas** — typed, documented interfaces. A badly described tool gets called wrongly; this is prompt engineering as API design.
- **Error handling** — usually return the error *to the model* and let it adapt, rather than aborting.
- **Latency** — each iteration is a model call. Five at 2s each is a 10-second wait. Stream intermediate progress.
- **Authorisation on actions, not just reads** — an agent that sends email or updates a CRM needs *the acting user's* permissions, not a god-mode service account.
- **Human-in-the-loop** for consequential actions. Supervised autonomy first, loosen per action type.
- **Observability** — full traces of every plan, call and result. Agents fail confusingly and "it gave a weird answer" is undebuggable without them.

---

### Scoring yourself

- **9+ full marks** — you're ready on fundamentals; spend remaining time on the interview spine and mocks.
- **6-8** — solid base. Re-read the sections behind the ones you half-answered.
- **Below 6** — work through the doc again before attempting a mock; the spine assumes this material.

If you find yourself scoring half-marks repeatedly, the fix is a habit rather than more reading: **after stating a fact, immediately give the mechanism or the cost.** "Too slow" becomes "too slow, because nothing can be pre-computed — the score depends on the pair." That second clause is the whole difference between a junior and a senior answer.
