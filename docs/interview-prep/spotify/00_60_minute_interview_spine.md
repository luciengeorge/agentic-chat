# The 60-Minute Interview Spine — Spotify-lite

> This is the **only doc you actually need to internalize**. It's the script of what you'll say live, in roughly the order you'll say it.
>
> The big study guide (`01_…`) and diagrams are **defensive depth** — there to back you up if the interviewer probes. You don't recite them.
>
> Read this 3 times. That's enough.

---

## The 60-minute timeline

| Time | What's happening | Your job |
|---|---|---|
| 0–5 min | Intro, problem statement | Listen, then scope |
| 5–10 min | Scoping + capacity math | Ask 5 questions, do 3 numbers |
| 10–25 min | High-level architecture | Draw it, narrate it |
| 25–45 min | Deep dive (one area) | Go deep on the area you picked or they picked |
| 45–55 min | Trade-offs, week-1-vs-defer, "what breaks first" | Volunteer these — don't wait to be asked |
| 55–60 min | Their questions, your questions | Be honest, don't bluff |

---

## Phase 1 — Scope (5–10 min). Ask these 5.

Don't draw anything yet. Write the answers in the corner of the board.

1. **"1M users — is that MAU? What's the DAU split?"** → default 200K DAU
2. **"Global meaning where? US + EU + APAC?"** → default US + EU origins, CDN everywhere
3. **"Catalog size and growth?"** → default 10M tracks, +10K/day from publishers
4. **"Upload SLA — minutes, hours, days from publish to live?"** → default ~1 hour
5. **"What's NOT in scope? Recs, social, podcasts?"** → confirm out of scope

Optional 6th if there's space: **"Mostly mobile, web, both?"** → default ~70% mobile.

That's it. ~90 seconds total.

---

## Phase 2 — Capacity math (3 minutes, 3 numbers)

Do these on the board. Be loose. Round aggressively.

**1. Plays per day**
> 200K DAU × ~25 tracks/day ≈ **5M plays/day**

**2. Peak QPS**
> 5M / 86,400 ≈ 60 QPS average. Peak ~8× → **~500 starts/sec peak**

**3. Storage + bandwidth**
> Per track ~10 MB derived (3 bitrates) + ~30 MB master. 10M tracks → **~400 TB**.
> Bandwidth: 5M × 3 MB ≈ **15 TB/day egress, peak ~8 Gbps**.

**The shortcut to memorize:** 128 kbps × 1 minute ≈ 1 MB. Everything else falls out of that.

That's all the math you need. Don't grind harder.

---

## Phase 3 — High-level architecture (10–15 minutes)

Draw this:

```
        Mobile/Web/Desktop                  Publisher portal
               │                                   │
               ▼                                   ▼
        ┌──────────┐                        (direct multipart
        │   CDN    │◄──── audio + manifests   upload to S3)
        │  Cloud-  │
        │  Front   │      origin pull on miss
        └────┬─────┘─────────────────┐
             │                       ▼
        ┌──────────┐            ┌─────────┐
        │  API GW  │            │   S3    │
        │ TLS/auth │            │ masters │
        │ rate lim │            │+derived │
        └────┬─────┘            └─────────┘
             │                       ▲
   ┌─────────┼─────────┬──────────┐  │
   ▼         ▼         ▼          ▼  │
┌──────┐ ┌──────┐ ┌──────┐  ┌──────┐ │
│Catalg│ │Playbk│ │Search│  │Upload│ │
└──┬───┘ └──┬───┘ └──┬───┘  └──┬───┘ │
   │        │        │          │    │
   ▼        ▼        ▼          ▼    │
┌──────┐ ┌─────┐ ┌────────┐  ┌───────┴──────┐
│ Pg   │ │Redis│ │OpenSrch│  │ Kafka / SQS  │
└──┬───┘ └─────┘ └────▲───┘  └──────┬───────┘
   │                  │              ▼
   └── CDC ───────────┴────► Workers (FFmpeg, fingerprint, indexer)
```

**Narrate it in this order (~10 min total):**

1. **"Clients hit a CDN for audio, an API gateway for everything else."**
2. **"Behind the gateway, a small set of stateless services: catalog (track metadata), playback (issues signed manifest URLs), search (front for OpenSearch), upload (presigned S3 URLs for publishers)."**
3. **"Postgres for catalog and users — small, transactional. S3 for audio. Redis for hot caches. OpenSearch for search."**
4. **"Heavy work is async: publisher uploads land in S3, fire an event into a queue, workers transcode and fingerprint, then the catalog gets updated and an indexer picks up the change."**
5. **"That's the whole loop. Want me to go deep on a specific area?"**

Don't drown them in detail at this stage. The high-level is structural — depth comes next.

---

## Phase 4 — Deep dive (20 min). Pick ONE.

The recruiter said: "go deep on an area of your choice." Pre-pick one before the interview. **The safest choice is audio storage + global playback** because (a) it's the most clearly Spotify-flavored, (b) it has the cleanest trade-offs, and (c) every other area touches it.

If the interviewer steers you to a different one, you'll have light versions of the other two below.

### Default deep dive: Audio storage + global playback

Cover these 4 things, in this order:

**(a) Storage layout**
- Master FLAC (~30 MB) per track in S3 Glacier IR — cheap cold storage, instant retrieval. Source of truth.
- Derived AAC ladder in S3 Standard: 96 / 128 / 256 kbps, segmented for HLS.
- Why keep both: master = RAW, derived = JPEGs. Re-encoding any time we change codecs/bitrates needs the original.

**(b) HLS over progressive**
- Why HLS: chops audio into 6–10s segments + manifest. CDN caches small immutable segments well, player switches bitrate per segment based on network (adaptive bitrate). Progressive download is one big file → no ABR, weaker on mobile.
- Cost: more complex transcode pipeline. Worth it because 70% of users are mobile.

**(c) CDN, not direct-to-S3**
- CDN sits in front of S3. Listeners always hit the CDN. >95% of audio segments served from edge cache.
- Without CDN: S3 egress at $0.05/GB × 15 TB/day ≈ $22K/mo, plus latency hell for non-US users.
- With CDN: origin sees ~5% of requests; cost drops dramatically; latency is regional (~20ms vs ~100ms).

**(d) The play sequence end-to-end**
1. Client → playback service: "give me track abc"
2. Service → 302 to a signed manifest URL (15-min expiry)
3. Client fetches `.m3u8` from CDN (cached)
4. Client fetches segments from CDN, ABR switches as needed
5. Async: client posts `play_started` to a Kafka topic for analytics

**Latency target:** tap → audio out in <500 ms p50. Manifest cached at edge ~50ms, first segment cached ~200ms, decode buffer ~100ms.

That's the whole deep dive. ~15 minutes spoken.

### Light version: Search

If they steer you here:

- **Two products in one:** typeahead (per keystroke, p99 <50ms) and full search (p99 <200ms).
- **Index in OpenSearch:** docs for tracks/artists/albums, fields title/artist/album/popularity/language. Boost on popularity (log play count) + exact match + recency decay.
- **Typeahead path:** Redis prefix cache, fall back to OpenSearch completion suggester. Cache top prefixes from a daily warm job.
- **Indexer:** Postgres → Debezium CDC → Kafka → indexer worker → OpenSearch. Lag target <60s.
- **Why CDC over dual-write:** dual-writes drift; CDC makes Postgres the single source of truth.

### Light version: Upload pipeline

If they steer you here:

- **Direct-to-S3 multipart upload** with presigned URLs. Don't proxy 30 MB files through your servers.
- **Async pipeline kicked by S3 ObjectCreated event:** validate (ffprobe) → fingerprint (ACRCloud, *buy don't build*) → transcode (FFmpeg ladder + LUFS normalization) → finalize (catalog.status=READY, fire CDC, indexer picks up, pre-warm CDN).
- **Workers:** containerized, autoscale on queue depth. Per-publisher concurrency caps so a big label drop doesn't starve indie artists.
- **Idempotent** keyed by (track_id, version, stage). Retries safe.
- **Failure path:** DLQ + publisher portal shows FAILED with error, retry button.

---

## Phase 5 — Volunteer these unprompted (~5 min)

### Five trade-offs to name

1. **HLS vs progressive:** HLS for mobile + ABR; progressive defensible for MVP simplicity.
2. **Build vs buy fingerprinting:** **buy** (ACRCloud / Audible Magic). Building it is months of work for no product win.
3. **Single vs multi-region origin:** single in week 1. Add EU replica + origin failover after measured user pain.
4. **Plays in Postgres vs ClickHouse:** ClickHouse. Plays are append-only columnar — they don't belong in your transactional store.
5. **Dual-write vs CDC for search:** CDC. Postgres is the source of truth; dual-writes drift over time.

### Week 1 vs defer

**Ship week 1:**
- S3 + CloudFront, single bitrate HLS (128 kbps)
- Postgres for catalog, OpenSearch for search with popularity-only ranking
- Direct-to-S3 multipart upload, ECS workers + SQS, FFmpeg
- Single origin region, JWT auth, basic rate limiting

**Defer:**
- Multi-bitrate ladder (add 96 + 256 kbps after measurement)
- EU origin replica, multi-CDN
- Personalization re-ranking, vector search
- Lossless tier, DRM, offline downloads
- Recommendations, social, podcasts

### What breaks first (top 3)

1. **Origin egress bill** if CDN hit rate drops on long-tail catalog
2. **Transcoder backlog** on Friday-night release windows
3. **Postgres connection pool** under N+1 lookups in playback

---

## Phase 6 — When asked something you don't know

The right response is **never bluff**. The good response is:

> *"I haven't worked with X directly, but I'd reason about it like Y. Want me to walk through that, or shall we move on?"*

That's a positive signal, not a negative one. Senior engineers know what they don't know.

---

## The closing line (memorize this)

If they ask "what would you do differently?":

> *"Three things. I'd start with progressive download and migrate to HLS once I'd measured stalls in the field. I'd buy fingerprinting from day one rather than build. And I'd treat play events as a separate analytics product from the start — they don't belong in the transactional store."*

---

## What NOT to do

- Don't draw before you've scoped.
- Don't reach for Kafka, Cassandra, Spark unless you can defend each.
- Don't promise consistency you can't deliver. Search is eventually consistent. Plays are at-least-once. Be explicit.
- Don't volunteer every storage tier price or codec comparison. Save that for if they probe.
- Don't try to cover all three deep dives in detail unless they explicitly ask. Pick one, go deep.

---

## The minimum you have to be able to do live

If you can do these six things on a whiteboard in front of a stranger, you'll do well:

1. Ask 5 scoping questions, write the answers down
2. Sketch capacity numbers in 3 minutes (5M plays, 500 peak QPS, 15 TB/day)
3. Draw the high-level architecture in 10 minutes
4. Talk through one area deeply for 15 minutes (audio playback is your default)
5. Volunteer 3-5 honest trade-offs without prompting
6. Tell them what you'd ship in week 1 vs defer

Everything else in the bigger study guide is **insurance**. You probably won't say most of it. But it's there if they probe.

---

## 4-day plan (revised)

- **Day 1 (today):** read this doc 2-3 times. Read the bigger guide once for context.
- **Day 2:** rehearse the high-level architecture out loud, redraw on paper, rehearse the audio deep dive out loud (15 min uninterrupted).
- **Day 3:** redo the rehearsal. Self-quiz: scoping questions, capacity numbers, week-1-vs-defer.
- **Day 4 (interview day):** read the cheat sheet on the train. Walk in calm.
