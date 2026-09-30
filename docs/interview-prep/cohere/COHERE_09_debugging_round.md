# The Distributed Systems Debugging Round

> **This is a different interview format and most of your design prep doesn't transfer.**
>
> Candidate reports suggest Cohere's system design round sometimes isn't "design X on a whiteboard" at all. Instead: you're shown an existing distributed architecture that is failing in production, and asked to systematically isolate the problem — while the interviewer drip-feeds you new metrics, logs and findings as you go.
>
> It's an interactive diagnosis exercise. Prepare for it separately.

---

## 1. What they're actually testing

| They're watching for | Not really testing |
|---|---|
| Do you form hypotheses, or guess randomly? | Whether you get the "right" answer |
| Do you ask for the data that would *discriminate* between hypotheses? | How fast you solve it |
| Do you narrow systematically, or thrash? | Memorised failure taxonomies |
| Do you stay calm when new information contradicts you? | |
| Do you communicate what you're thinking as you go? | |
| Do you separate *mitigate now* from *fix properly*? | |

The interviewer usually knows the root cause. What they're grading is the **search process**, and specifically whether you abandon a hypothesis gracefully when the evidence kills it.

---

## 2. The framework — say it out loud, then follow it

```
OBSERVE     →  What exactly is broken? Who's affected? Since when?
HYPOTHESISE →  What could produce these symptoms? List several.
TEST        →  What single piece of data separates them? Ask for it.
NARROW      →  Kill hypotheses. Repeat from HYPOTHESISE.
MITIGATE    →  Stop the bleeding (often before you know the cause)
FIX         →  Address the root cause
PREVENT     →  What detects this earlier next time?
```

**Open by stating the framework.** It costs ten seconds and it tells the interviewer you have a method rather than intuition:

> *"Before I start guessing, let me establish what's actually broken and who's affected, then I'll work through candidate causes and tell you what data would separate them. I'll also flag early if there's something we should do to mitigate while we're still diagnosing."*

### The single most important technique: binary search the stack

Distributed debugging is a **search problem**. Don't start at the top and walk down — pick a midpoint, test it, and eliminate half the system.

```
Client → CDN/LB → Gateway → Orchestrator → Retrieval → Vector store
                                         ↘ Model serving → GPU
                     ↑
              test HERE first — is the request even arriving?
              Then you've halved the search space either way.
```

Say it explicitly: *"Rather than walking the stack top to bottom, I'd test in the middle — if the orchestrator is receiving and emitting normal traffic, the problem is downstream and I can ignore everything above it."*

---

## 3. The opening questions (memorise these)

Whatever the scenario, start here. These are cheap, and each one halves the space.

**Scope**
1. *"Who's affected — all users, one tenant, one region, one workload type?"*
2. *"What fraction of requests? 100%, or 5%?"*
3. *"Is it total failure or degradation?"*

**Time**
4. *"When did it start? Sudden or gradual?"*
5. *"**What changed around that time?** Deploy, config change, customer onboarding, index rebuild, certificate rotation?"*

**Signal**
6. *"What's the actual error — status codes, exceptions, timeouts, or no error at all?"*
7. *"What do latency percentiles look like? Is p50 fine and p99 terrible, or is everything slow?"*

> **Question 5 is the highest-yield question in the entire round.** Most production incidents are caused by a change. Asking it early is a strong signal, and it often shortcuts the whole exercise.

The **p50 vs p99** distinction in question 7 is the second-best. "Everything slow" and "the tail is slow" have almost disjoint cause sets — the first suggests a shared bottleneck, the second suggests contention, a bad shard, GC, or a cold cache path.

---

## 4. AI systems fail differently — this is the Cohere-specific edge

In a normal web service, failures announce themselves: 500s, timeouts, alerts firing.

**The hardest failures in an AI system throw no error at all.** The request returns 200. Latency is normal. The dashboard is green. And the answer is quietly, confidently wrong.

That's worth saying out loud if the scenario is AI-shaped, because it reframes what you should be looking at:

> *"One thing I'd flag early: in a retrieval system the worst failures are silent. If retrieval quality degrades, every request still returns 200 with a fluent answer — nothing errors. So I wouldn't rely only on error rates and latency. I'd want retrieval quality metrics, and ideally a canary eval set running continuously against production."*

### The silent-failure taxonomy

| Failure | Looks like | How you'd actually catch it |
|---|---|---|
| Index partially rebuilt / corrupted | Normal latency, worse answers | Recall@k on a canary set; index doc count |
| Embedding model version mismatch | Normal latency, nonsense results | Compare model version at write vs query time |
| ACL sync stalled | Everything fine, until it's a breach | ACL staleness metric, denied-chunk rate change |
| Chunking change shipped | Slightly worse answers | Golden set regression in CI |
| Rerank silently failing open | Faster than usual, worse results | Watch for *improved* latency with degraded quality |
| Context truncation | Answers ignore some evidence | Prompt token count distribution |
| Tool returning errors to agent | Agent hedges or hallucinates | Tool error rate per tool |

**"Latency improved and quality dropped"** is a wonderfully counter-intuitive signal — something in the pipeline is being skipped. Worth having ready.

---

## 5. Practice scenarios

Work through each: what would you ask, in what order, and what's your hypothesis tree?

### Scenario A — "Retrieval quality dropped for one customer"

*Users at one tenant say answers have got noticeably worse since Tuesday. No errors. Latency unchanged.*

**Ask:** What happened Tuesday? Only this tenant, or did others change too? Did their corpus change — a bulk import, a migration? Any deploy? What's the index document count trend?

**Hypothesis tree:**
- Ingestion broke → index is stale or partial → *check doc count and last-indexed timestamp*
- A bulk import flooded the index with low-quality content diluting results → *check recent ingestion volume*
- Their ACL sync broke → over-filtering → fewer valid candidates survive → *check denied-chunk rate*
- An embedding model or chunking change shipped → *check versions, check other tenants*
- Their usage changed — new team asking a different kind of question → *not a bug*

**The discriminating question:** *"Did other tenants degrade at the same time?"* If yes it's a deploy. If no it's tenant-specific data or config. That single question splits the tree cleanly.

### Scenario B — "p99 latency tripled overnight, p50 is fine"

**Ask:** Which stage? Is there per-stage instrumentation? Did traffic volume change? Did the index grow? Any GPU-side change?

**Hypothesis tree:**
- Cache hit rate dropped → cold path now common → *check cache hit rate*
- Index grew past a memory threshold → swapping → *check RSS vs available RAM*
- One shard or replica is unhealthy and it's request-routing-dependent → *check per-replica latency*
- GPU queueing — a bulk ingestion job is competing with interactive traffic → *check GPU utilisation and batch queue depth*
- Connection pool saturation → *check pool wait time*

**p50 fine + p99 bad** almost always means **contention or a bad minority path**, not a universal slowdown. Say that.

**Scenario B is the most likely one to appear**, because it has a rich hypothesis space and a clean discriminator (per-stage timing).

### Scenario C — "Agents are timing out, but only for one customer"

**Ask:** Which tools are involved? What's the iteration count distribution? Is one downstream integration slow? Did their data change?

**Hypothesis tree:**
- A downstream SaaS integration (their Salesforce, say) is rate-limiting us → *check tool error and latency per tool*
- Agents are looping — hitting the iteration cap — because a tool keeps returning something unhelpful → *check iteration distribution*
- That customer's prompts are longer → more tokens → slower generation → *check token counts*
- Their GPU allocation is under-provisioned relative to their usage → *check per-tenant GPU queue*

**The discriminator:** iteration count distribution. If runs are hitting the cap, it's a loop problem, not a latency problem — completely different fix.

### Scenario D — "The assistant is citing documents that don't exist"

*Users click a citation and get a 404.*

**Ask:** Are the chunks in the index but the documents deleted at source? When did the last sync run? Is it all citations or a subset?

**Hypothesis tree:**
- Deletion propagation is broken — documents removed at source, chunks still indexed → *most likely*
- Citation ID mapping broke after a reindex → IDs point at the wrong place
- The model is fabricating citation IDs → *check whether the cited IDs exist in the index at all*

**This one is nastier than it looks**: if deleted documents are still retrievable, that's potentially a **data governance incident**, not just a broken link. Someone may have deleted a document *specifically* because it shouldn't be accessible. Escalate accordingly — and saying that shows judgement.

### Scenario E — "Ingestion backed up overnight, nothing has processed since 2am"

**Ask:** Queue depth trend? Are workers alive? Are they crash-looping? DLQ growth? What ran at 2am?

**Hypothesis tree:**
- Workers crash-looping on a poison message → *check DLQ and restart counts*
- Downstream dependency down — the embedding service, or the vector store → *check its health*
- Credential or token expiry on a source connector → *check auth errors* (2am is suspiciously like a scheduled rotation)
- Autoscaling failed to scale up → *check worker count vs queue depth*
- A deploy at 2am → *check deploy log*

**"Nothing since 2am" is a strong hint at something scheduled** — cron, token rotation, certificate renewal, a nightly job. Chase the clock.

---

## 6. Things that score points

**Ask what changed, early.** Highest-yield question available.

**Separate mitigation from diagnosis.** *"Before we go further — can we fail over to the previous index version? That stops customer impact while we keep investigating."* Senior engineers stabilise first and understand second.

**Name your hypotheses out loud, and rank them.** *"Three things could cause this. I think it's most likely the second, because the timing lines up with the deploy. Here's the data that would confirm it."*

**Abandon hypotheses cleanly.** *"That rules out the cache theory — so I'll drop it and focus on the index."* Interviewers are specifically watching whether contradicting evidence makes you defensive.

**Say what you'd want instrumented that isn't.** *"I'd be much faster here if we had per-stage timing on the retrieval path. I'd add that regardless of what this turns out to be."*

**Finish with prevention.** *"Once fixed: a canary eval running continuously against production would have caught this in minutes rather than days."* The round usually ends here and it's the easiest place to score.

## Things that lose points

- Guessing without asking for data
- Fixating on your first hypothesis after evidence contradicts it
- Going silent while you think (they can't grade what they can't hear)
- Jumping to root cause without scoping the blast radius
- Ignoring "what changed?" and reasoning from first principles about a system you didn't build
- Forgetting that mitigation exists as a separate move from diagnosis

---

## 7. The one-paragraph opener

Memorise the shape, not the words:

> *"Let me start by scoping the blast radius — who's affected, what fraction of traffic, and whether it's total failure or degradation. Then when it started, and critically what changed around that time, because most production incidents trace back to a change. From there I'll work through candidate causes and tell you which piece of data would separate them, rather than guessing. And if there's an obvious mitigation while we're still diagnosing, I'd want to take it early rather than wait for root cause."*

That paragraph demonstrates method, prioritisation, and operational maturity before you've been told a single detail.

---

## 8. Quick reference — where to look by symptom

| Symptom | First three places to look |
|---|---|
| Everything slow | Shared dependency, DB connection pool, GPU saturation |
| Tail slow, median fine | Contention, bad replica, cold cache path, GC |
| One tenant affected | Their data, their ACLs, their quota, their integrations |
| Started at a specific time | Deploy, cron, token/cert expiry, scheduled job |
| Gradual degradation | Growth hitting a threshold — memory, disk, index size, table scan |
| Errors but no latency change | Downstream returning fast failures |
| **Latency improved, quality dropped** | **Something is being skipped — rerank failing open, cache serving stale, truncation** |
| No errors, worse answers | Index staleness, embedding version mismatch, chunking change, ACL over-filtering |

That last-but-one row is the one nobody expects. Keep it handy.
