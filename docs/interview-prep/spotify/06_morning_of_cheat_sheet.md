# Morning-of Cheat Sheet — Spotify-lite, 1M MAU

Read this once on the train. Don't try to memorize, just refresh.

---

## Step 1 — Scope (60–90 sec, before drawing)

Ask, write answers in corner of board:

- DAU vs MAU? → assume **200K DAU / 1M MAU**
- Geography? → **US + EU origins, CDN everywhere**
- Catalog size & growth? → **10M tracks, +10K/day**
- Publishers + upload SLA? → **~1K active, ~10K/day, live in <1 hr**
- Mobile %? → **~70% mobile**
- Tiers / lossless? → **AAC 96/128/256, no FLAC v1**
- Out of scope? → **recs, social, podcasts, ads**
- Top NFRs? → **playback latency + cost discipline**

---

## Step 2 — Capacity numbers (have these ready)

| Metric | Value |
|---|---|
| DAU | 200K |
| Plays/day | ~5M |
| Play QPS (peak) | ~500 starts/sec |
| Search QPS (peak) | ~120 |
| Typeahead QPS (peak) | ~600 |
| Storage/track (all bitrates + master) | ~40 MB |
| Total catalog storage | ~400 TB |
| Egress/day | ~15 TB |
| Peak bandwidth | ~8 Gbps |
| All-in monthly cost (rough) | $30–50K, mostly CDN + storage |

Memory hook: **5M plays, 500 peak QPS, 8 Gbps, 400 TB.**

---

## Step 3 — Default architecture (draw this fast)

```
Clients ─► CDN ─► (audio segments + manifests)
   │         │
   │         └─ origin pull ─► S3
   │
   └─► API GW ─► Catalog | Playback | Search | Upload | User
                    │         │         │        │
                  Postgres   Redis  OpenSearch  S3
                    │
                    └─ CDC ─► Kafka ─► Workers (transcode, fingerprint, indexer) ─► S3 + OS + ClickHouse
```

Stack call: **S3 + CloudFront + Postgres + OpenSearch + Redis + ECS workers + SQS/Kafka.** Boring, defensible, ships in week 1.

---

## Step 4 — Pick a deep dive (or all three if asked)

**Audio playback:**
- HLS over progressive (ABR + cache friendliness)
- Encoding ladder: 96 / 128 / 256 kbps AAC, 6–10s segments
- Content-addressed S3 keys, immutable + 30d cache
- Manifests = signed URLs, 15 min expiry
- Latency budget: tap → audio in <500 ms p50

**Search:**
- OpenSearch + Redis prefix cache
- Typeahead (separate path, p99 <50ms) vs full search (p99 <200ms)
- CDC from Postgres → Kafka → indexer (lag <60s)
- Boost: popularity (log play count), exact match, recency decay
- Personalization re-rank in app layer over top 50

**Upload:**
- Direct-to-S3 multipart with presigned URLs
- Async pipeline: validate → fingerprint → transcode (FFmpeg, LUFS norm, waveform) → finalize
- Idempotent workers keyed by (track_id, version, stage)
- Per-publisher concurrency caps (Redis token bucket)
- Buy fingerprinting (ACRCloud), don't build

---

## Step 5 — Trade-offs to volunteer

- HLS vs progressive: HLS wins long-term, defend the complexity tax
- One CDN vs multi-CDN: one for week 1, multi after first outage
- Postgres vs Cassandra: Postgres at 1M users; Cassandra is premature
- Build vs buy fingerprinting: buy
- Plays in Postgres vs ClickHouse: ClickHouse, plays are columnar/append-only
- Dual-write vs CDC for search: CDC is the source of truth, dual-writes drift

---

## Step 6 — What breaks first (in order)

1. **Origin egress bill** when CDN hit rate drops
2. **Transcoder backlog** on Friday release windows
3. **Search latency** under fuzzy/wildcard queries
4. **Postgres connection pool** on N+1 in playback
5. **Indexer lag** during bulk catalog imports
6. **Hot S3 prefix** on viral release (CDN absorbs almost all)

---

## Step 7 — Week 1 vs defer

**Ship week 1:** S3+CloudFront, single bitrate HLS, Postgres, OpenSearch with popularity-only ranking, direct-to-S3 multipart upload, ECS+SQS workers, single-region origin, JWT auth.

**Defer:** multi-bitrate ladder, EU origin replica, fingerprinting service, personalization, DRM/offline, lossless, multi-CDN, recommendations.

---

## Step 8 — Things to NOT do

- Don't draw before scoping
- Don't reach for Kafka/Cassandra/Spark unprompted
- Don't promise consistency you can't deliver (search is eventual, plays are at-least-once)
- Don't skip the upload deep dive
- Don't forget cost — have $30–50K/mo number ready

---

## Step 9 — Scaling story (if asked "what changes at 100M users?")

- Multi-region origins (US, EU, APAC) with active-active S3 buckets
- Multi-CDN with steered DNS for resilience
- Catalog Postgres → split by entity (tracks, users), eventually shard users by user_id
- Plays pipeline → real Kafka cluster with cross-region mirroring → ClickHouse
- Dedicated typeahead cluster separate from full-search ES
- Pre-warming pipeline for new releases (proactively GET first segments at all POPs)
- Cost discipline becomes #1: tier storage (Glacier IR for masters >30d), negotiate CDN contracts, audit hit rates weekly

---

## Bonus — closing line if asked "what would you do differently"

> "Three things: I'd start progressive and migrate to HLS once I've measured stalls; I'd buy fingerprinting from day one; and I'd treat play events as a separate analytics product from the start, not bolt them onto the transactional store."

You've got this.
