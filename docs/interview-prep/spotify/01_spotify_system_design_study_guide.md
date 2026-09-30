# Simplified Spotify — System Design Interview Study Guide

> Audience: you, 4 days out, comfortable-but-rusty.
> Brief: design search + playback + publisher uploads for ~1M global users, startup context.
> Style the interviewer wants: scope first, then architecture, then a deep dive, with honest trade-offs and a week-1 / defer split.

---

## 0. How to run the first 5 minutes

Before drawing anything, lock down scope. Say it out loud. The interviewer's note told you exactly what they care about, so make those questions yours.

**Ask in this order, and write the answers in the corner of the whiteboard:**

1. **Users & scale.** "1M total users — is that registered, MAU, or DAU? What's the DAU?"
   - Default if they shrug: 1M MAU, 200K DAU (20% is a fine startup baseline).
2. **Geography.** "Global meaning where, concretely? US + EU + a couple of APAC pops, or every continent day one?"
   - Default: US + EU origins, CDN everywhere.
3. **Catalog size.** "How many tracks at launch? How fast does the catalog grow?"
   - Default: 10M tracks at launch, ~10K new tracks/day from publishers.
4. **Publishers.** "Who uploads — labels, indie artists, distributors? What's the upload SLA — minutes, hours, days to go live?"
   - Default: ~1K active publishers, 10K tracks/day, "live within 1 hour" is acceptable.
5. **Listening profile.** "Mobile-heavy? Web? Offline matters?"
   - Default: ~70% mobile, web + desktop too. Offline is a v2 nice-to-have.
6. **Audio quality / tiers.** "Free + paid? Lossless tier?"
   - Default: AAC at 96/128/256 kbps for MVP. FLAC lossless deferred.
7. **What we're NOT building.** Recommendations, social, podcasts, ads — name them out loud and confirm out of scope.
8. **Non-functional priorities.** "Most important: low playback latency? Search latency? Time-to-publish? Cost?"
   - For startup framing: low playback latency + cost discipline. Search latency matters but <100ms is fine, doesn't need <10ms.

This 60-90 second exchange is half of the "scoping" grade. Don't skip it even if you think you know the answers.

---

## 1. Capacity math (do this on the board, fast)

Numbers the interviewer will love you for sketching:

**DAU & sessions**
- DAU: ~200K
- Avg listening: 1.5 hr/day → ~26 tracks/day per active user (3.5 min/track)
- Daily plays: 200K × 26 ≈ **5M plays/day**
- Avg play QPS: 5M / 86,400 ≈ **60 starts/sec**, peak ~5–10× → **~500 starts/sec**

**Search QPS**
- Assume 5 searches per DAU per day → 1M searches/day → ~12 QPS avg, **~120 QPS peak**
- Typeahead is much higher: each keystroke = a request. Conservatively 5× search QPS → **~600 QPS peak**

**Audio storage**
- Per track, multi-bitrate ladder: ~2 MB (96k) + ~3 MB (128k) + ~6 MB (256k) ≈ 11 MB derived
- Plus the master (FLAC ~30 MB) → ~40 MB/track total
- 10M tracks × 40 MB ≈ **400 TB**. Grows ~400 GB/day at 10K new tracks.
- Object storage (S3 standard) cost: ~$0.023/GB/month → ~$9K/month at 400 TB. Move masters to Glacier IR after 30d → much cheaper.

**Egress / bandwidth**
- 5M plays/day × ~3 MB avg streamed ≈ **15 TB/day egress**
- That's ~175 MB/s avg, **~1 GB/s = 8 Gbps peak**
- Origin egress without a CDN at $0.05/GB ≈ $750/day = **$22K/month** in raw egress alone. With a CDN at 90% hit rate, the origin bill drops to ~$2K/mo and CDN egress around $0.005–0.02/GB depending on region/contract.

**Upload volume**
- 10K tracks/day, masters ~30 MB each → ~300 GB/day upload to S3. Trivial.
- Transcode work: each track ~3 min CPU on a single core for the full ladder → ~30K core-min/day → ~20 cores running 24/7. Burst-scale on Friday release windows.

**Punchline:** at 1M users this is a small system by Spotify standards. The hard parts are **global latency, upload-to-live SLA, search relevance, and unit economics on egress**, not raw scale.

---

## 2. High-level architecture

```
                         ┌────────────┐
       Mobile / Web / ◄──┤    CDN     │◄────── Audio segments + manifests + cover art
       Desktop clients   │  (CloudFront/Fastly)
                ▲        └────┬───────┘
                │             │ origin pull (rare, on miss)
                ▼             ▼
          ┌──────────┐   ┌──────────────────────┐
          │  API GW  │──▶│  Object storage (S3)  │  audio masters + derived
          │  (TLS,   │   └──────────────────────┘
          │  auth,   │
          │  ratelmt)│        ▲ writes
          └────┬─────┘        │
               │              │
   ┌───────────┼──────────────┼────────────────┐
   ▼           ▼              │                ▼
┌─────────┐┌─────────┐  ┌───────────┐    ┌───────────┐
│Catalog  ││Playback │  │  Upload   │    │  Search   │
│service  ││service  │  │  service  │    │  service  │
└────┬────┘└────┬────┘  └─────┬─────┘    └─────┬─────┘
     │          │             │                │
     ▼          ▼             ▼                ▼
   ┌─────────────────┐   ┌──────────┐    ┌──────────────┐
   │   Postgres      │   │  Kafka / │    │  OpenSearch  │
   │ (catalog, users)│   │   SQS    │    │  cluster     │
   └─────────────────┘   └─────┬────┘    └──────▲───────┘
        ▲                      │                │
        │                      ▼                │
        │              ┌────────────────┐       │
        │              │ Worker pool:   │       │
        │              │ - Transcoder   │       │
        │              │ - Fingerprint  │───────┘  (catalog change → indexer)
        │              │ - Loudness     │
        │              │ - Indexer      │
        │              └────────────────┘
        │
        └── Redis (hot metadata, sessions, autocomplete)
```

**Service boundaries (intentionally small for a startup):**

- **API gateway** — TLS termination, JWT validation, per-user rate limiting, request routing.
- **Catalog service** — CRUD over tracks, albums, artists, playlists. Source of truth in Postgres.
- **Playback service** — given a track ID + user, returns a signed manifest URL and writes a "play started" event.
- **Upload service** — issues presigned S3 multipart URLs, accepts metadata, manages publisher state machine (DRAFT → PROCESSING → READY/FAILED).
- **Search service** — thin proxy in front of OpenSearch with ranking/personalization/typeahead logic and Redis cache.
- **User service** (implied) — auth, profile, library, subscription tier.
- **Worker pool** — stateless containers consuming a queue: transcode, fingerprint, loudness normalization, search indexing.

**Why this shape**
- Stateless services behind a load balancer → trivial horizontal scale.
- All heavy lifting is async (transcoding, indexing). The synchronous request path stays under 100 ms.
- Object storage is the only "infinite" thing. Postgres holds metadata only — small.
- One write-side primary (Postgres), one query-side index (OpenSearch). CDC keeps them in sync.

---

## 3. API surface (sketch the important ones)

You don't need to enumerate every endpoint, but be ready with these:

```
# Playback
GET  /v1/tracks/{id}/manifest       → 302 to signed HLS .m3u8 URL
POST /v1/plays                      → record play_start (fire-and-forget, returns 202)

# Search
GET  /v1/search?q=...&type=track,artist,album&locale=en
GET  /v1/typeahead?q=br             → top-10 prefix matches, Redis-cached

# Catalog (read)
GET  /v1/tracks/{id}
GET  /v1/artists/{id}/tracks?cursor=...
GET  /v1/albums/{id}

# Upload (publisher API)
POST /v1/uploads                    → returns {upload_id, parts: [{url, part_no}, ...]}
PUT  <presigned_part_url>           (client → S3 directly)
POST /v1/uploads/{id}/complete      → finalize multipart, kicks off processing
POST /v1/tracks                     → submit metadata referencing upload_id
GET  /v1/tracks/{id}/status         → DRAFT|PROCESSING|READY|FAILED with error detail
```

Two things to call out unprompted:
- **Manifests are short-lived signed URLs (5–15 min)**. Audio segments inside the manifest are also signed (or the manifest carries a signed cookie). Expiry prevents share-the-link abuse.
- **Uploads go client → S3 directly**. Never proxy GBs through your app servers.

---

## 4. Data model essentials

```
artist(id, name, bio, country, popularity_score)
album(id, artist_id, title, release_date, cover_art_url, label)
track(id, album_id, title, duration_ms, isrc, explicit, status,
      master_s3_key, hls_manifest_url, fingerprint_hash)
publisher(id, name, contact_email, kyc_status, daily_quota)
user(id, email, country, tier, created_at)
play_event(user_id, track_id, ts, region, ms_played, source)   ← analytics, ClickHouse not Postgres
user_library(user_id, track_id, added_at)                       ← shard by user_id eventually
```

**Why Postgres for catalog at 1M users:** ~10M tracks × a few hundred bytes/row = a few GB. Easily fits in a single primary with read replicas. Don't reach for Cassandra here — you'd be paying complexity tax for nothing.

**Why ClickHouse (or BigQuery) for play_event:** plays are append-only, columnar-friendly, queried in aggregates ("top tracks this week"). Postgres would die at ~100M rows of analytics writes if you let them in.

---

## 5. Deep dive A — Audio storage & global playback

### 5.1 The choice that defines everything: HLS vs progressive

| | Progressive download (range requests on a single MP3/AAC) | HLS / DASH (segmented, manifest-driven) |
|---|---|---|
| Setup cost | Low — upload, expose URL, done. | Medium — segment on transcode, generate manifest. |
| Bandwidth efficiency | Wasted bytes on skip/seek. | Excellent — only fetched segments are paid for. |
| Adaptive bitrate | None. Pick a quality and pray. | Native — switch bitrate per segment based on network. |
| CDN cache friendliness | One big object → spotty hit rates, 206 partial-content quirks. | Many small immutable segments → great hit rates, easy to invalidate by version. |
| Mobile / poor networks | Stalls more. | Smoothly degrades. |
| Player complexity | Trivial. | Needs HLS-capable player (every modern one is). |
| Offline | Easy. | Easy (download all segments). |

**Recommendation:** HLS from week 1, with segments of 6–10 seconds. The "complexity tax" is mostly absorbed by FFmpeg + a player library; you get the ABR and CDN wins for free. Progressive is fine if the interviewer pushes back hard on simplicity, but be ready to defend why HLS is worth it for a global mobile-heavy product.

### 5.2 Encoding ladder

For each track, the transcoder produces:
- **HLS / AAC 96 kbps** — free tier, weak networks
- **HLS / AAC 128 kbps** — default
- **HLS / AAC 256 kbps** — paid tier, wifi
- (Defer) **HLS / FLAC or ALAC** — lossless tier, v2

Plus: a **waveform PNG** for the player UI, **loudness normalization** to −14 LUFS (industry standard so volume is consistent across tracks), and **silence trimming** at start/end.

Storage layout:
```
s3://audio-masters/<sha256-of-master>.flac
s3://audio-derived/<track_id>/v1/aac96/playlist.m3u8
s3://audio-derived/<track_id>/v1/aac96/seg-001.aac
s3://audio-derived/<track_id>/v1/aac128/...
s3://audio-derived/<track_id>/v1/aac256/...
```
- **Content-addressed prefixes** to avoid S3 hot-prefix throttling (don't bucket by date — a Friday release will throttle you).
- **Versioned (`/v1/`) so re-encodes don't fight cached old segments.** Bump to `/v2/` when you change settings; old version can be GC'd after CDN TTL expires.

### 5.3 Global delivery — where the CDN earns its keep

```
client request for /track/abc/seg-042.aac
  → CDN edge POP (< 30 ms RTT for ~80% of users globally)
     → cache HIT  → byte stream back to client (the common case)
     → cache MISS → fetch from S3 origin (us-east + eu-west)
                  → fill edge cache, return to client
```

**Cache strategy**
- Audio segments: `Cache-Control: public, max-age=2592000, immutable` (30 days). Immutable = CDN never re-validates.
- Manifests (`.m3u8`): `max-age=60` — you may need to update them quickly (e.g., add new segments for a long track or hotfix). Or also long-cache if manifests are versioned.
- Cover art / images: long cache, content-addressed.

**Hit rate target:** >95% on segments. The long tail of unpopular tracks pulls this down; popular tracks get hit rates >99%.

**Multi-CDN?**
- Defer for week 1 — single CDN (CloudFront *or* Fastly) is fine for 1M users.
- Add multi-CDN with steered DNS once you've felt one CDN regional outage hurt; before that it's premature.

**Multi-region origin?**
- One S3 bucket with **Cross-Region Replication** to EU, with an origin failover group on the CDN. Costs ~2× storage but halves origin RTT for European requests on cache misses. Good week-2 move.

### 5.4 The play sequence end-to-end

1. Client: "play track abc"
2. → `GET /v1/tracks/abc/manifest` with JWT
3. Playback service: validates user can play (tier, region restrictions), looks up `hls_manifest_url`, signs it (CloudFront signed cookie or signed URL with 15-min expiry), 302s to CDN URL.
4. Client: fetches `.m3u8` from CDN (ms latency, cached).
5. Player picks a bitrate based on initial bandwidth estimate, requests `seg-001.aac` from CDN.
6. While playing seg-001, fetches seg-002 and 003 (small buffer ahead).
7. ABR logic in the player swaps bitrate every segment if network changes — no server involvement.
8. Async: client posts `play_started` to `/v1/plays`. Server writes to a Kafka topic, ClickHouse consumes for analytics, royalty reporting, recs.

**Latency budget for "tap → audio comes out":** target <500 ms p50.
- Manifest request: ~50 ms (cached at CDN edge)
- First segment: ~200 ms (cached at CDN edge)
- Player decode + buffer: ~100 ms
- Slack: 150 ms

Cache miss on the first segment of an unpopular track is the killer. Mitigations: prefetch first 1–2 segments at search time; pre-warm CDN for new releases by GET-ing them from N regions right after publish.

### 5.5 Offline + DRM (deferred but mention it)

- Encrypted segments using AES-128 with key delivery via license server.
- Widevine (Android/web), FairPlay (Apple), PlayReady (Windows). All three is a project — pick one for week 1 if needed, usually Widevine.
- Defer entirely if free-tier only.

---

## 6. Deep dive B — Search at scale

Search is two products dressed as one: **typeahead** (every keystroke, very latency-sensitive, narrow result set) and **full search** (one query, broader results, ranking matters).

### 6.1 The index

OpenSearch / Elasticsearch (or Meilisearch / Typesense if you want simpler ops; both are credible startup picks). Document shape:

```json
{
  "id": "track:abc",
  "type": "track",
  "title": "Blinding Lights",
  "title_normalized": "blinding lights",
  "artist_name": "The Weeknd",
  "album_name": "After Hours",
  "duration_ms": 200040,
  "popularity": 9871234,
  "release_date": "2019-11-29",
  "language": "en",
  "explicit": false,
  "available_regions": ["US", "GB", "..."]
}
```

Separate document types for `track`, `artist`, `album`, `playlist`. You can put them in one index (cheaper, single query) or separate (cleaner, easier to tune analyzers per type). For 10M total docs, **one index is fine**; revisit if it grows past ~50M.

### 6.2 Analyzers and ranking

- **Lowercase + ASCII folding** — "Beyoncé" matches "beyonce".
- **Per-language analyzers** — Korean, Japanese, Russian, Hindi need their own tokenizers. Detect query language or fall back to `standard`.
- **Phonetic** (Double Metaphone) for "rhianna" → "rihanna", optional.
- **Edge n-gram** field (`title.edge`) for typeahead prefix matching.
- **Boosts:**
  - `popularity` (log-scaled play count, refreshed nightly) — heavy boost
  - exact match on `title.keyword` — heavy boost
  - artist popularity — moderate boost
  - recency for new releases — small decay-based boost (`function_score` with gauss decay over release_date)
- **Personalization** (re-rank top 50 in app layer, not in ES):
  - boost artists in user's library
  - boost artists from user's locale
  - down-weight tracks user has explicitly disliked

### 6.3 Typeahead

Path is separate because the latency budget is different — you want **<50 ms p99**.

```
client types "br"
  → /v1/typeahead?q=br&locale=en
    → Redis GET typeahead:en:br   (HIT 80%+ → return immediately)
    → if MISS: query OpenSearch completion suggester (top-10 across tracks/artists)
              → SETEX in Redis for 5 min
              → return
```

For very common prefixes ("a", "th", "the"), warm the cache from a daily job over top-N searches.

### 6.4 Indexing pipeline (eventual consistency, target lag < 60s)

```
catalog write (publisher publishes a track)
  → Postgres CDC (Debezium) → Kafka topic catalog.changes
    → Indexer worker (consumes Kafka)
      → bulk POST to OpenSearch
      → on success, commit Kafka offset
```

Why CDC instead of dual-write from the catalog service? Dual-writes let you forget to update one side, or fail halfway and lose consistency. CDC is the source of truth — Postgres is the only thing the service writes to, the index is derived.

**Backfill story:** if OpenSearch dies or you change the index mapping, run a job that reads Postgres in chunks and bulk-indexes. Should be able to rebuild 10M docs in a few hours.

### 6.5 Sharding & sizing

- 10M docs × ~1 KB ≈ 10 GB. With 2 replicas → 30 GB. **Three shards × three nodes** is generous. A managed cluster like AWS OpenSearch r6g.large.search × 3 ≈ $300/mo handles this with room.
- Hot shard risk: if you shard by `_id`, a viral artist's tracks scatter across shards (good). Don't shard by artist or you'll create hot spots.

### 6.6 Failure modes for search
- ES query latency spikes under fuzzy / wildcard queries → block wildcard queries at the API, cap fuzziness to AUTO with prefix length 2.
- Indexer lag during bulk catalog imports → backpressure the indexer, scale workers horizontally, accept temporary lag (publisher portal already shows "PROCESSING").
- Stale popularity scores → run nightly aggregation from ClickHouse → bulk update popularity field (or use a separate `popularity` index with a denorm join).

---

## 7. Deep dive C — Upload & ingestion

This is usually the area least practiced and highest-signal — interviewers love to probe here because it has so many trade-offs.

### 7.1 Upload itself (the synchronous bit)

```
publisher portal
  ↓ POST /v1/uploads {filename, size, checksum}
upload service
  ↓ creates upload record (DRAFT), allocates upload_id
  ↓ calls S3 CreateMultipartUpload, returns presigned URLs for each part
publisher
  ↓ PUTs each part directly to S3 (parallel, resumable)
  ↓ POST /v1/uploads/{id}/complete
upload service
  ↓ S3 CompleteMultipartUpload (verifies all parts present)
  ↓ marks upload COMPLETE, fires ObjectCreated event
```

Why this shape:
- **Direct-to-S3** — you don't pay bandwidth or burn web servers proxying 30 MB files.
- **Multipart** — resumable, parallel, handles flaky connections.
- **Presigned URLs** scoped per part — minute-level expiry, can't be reused.
- **Server only sees metadata + control** — clean separation, easy to scale.

### 7.2 Async processing pipeline

The S3 ObjectCreated event publishes to Kafka (or SNS+SQS). One topic per stage so workers can scale independently:

```
upload.completed
   → fanout: validate, fingerprint, transcode

validate worker
   - probe with ffprobe: codec, bit depth, sample rate, length, integrity
   - reject if corrupt → status FAILED + error_code

fingerprint worker
   - compute audio fingerprint (Chromaprint, or licensed: ACRCloud / Audible Magic)
   - lookup against rights database
   - if match to a different rights holder → status BLOCKED, manual review queue
   - else → mark fingerprint stored, fire fingerprint.ok

transcode worker
   - FFmpeg job: produce HLS ladder (96/128/256 kbps AAC)
   - apply loudness normalization (target -14 LUFS)
   - generate waveform PNG
   - upload derived assets to s3://audio-derived/<track_id>/v1/...
   - fire transcode.complete

finalize worker (consumes validate.ok + fingerprint.ok + transcode.complete)
   - update catalog: status = READY, hls_manifest_url = ...
   - publish catalog.changes event (search indexer picks up)
   - optionally: pre-warm CDN by GET-ing first segment from a couple of regions
   - send notification webhook to publisher
```

### 7.3 Workers — what runs where

- **Containerized FFmpeg** in ECS / Kubernetes. Each container processes one track at a time on N cores.
- **Autoscale on queue depth** (KEDA or AWS auto-scaling on SQS ApproximateNumberOfMessages). Target queue depth = 10× current concurrency, scale down with a long cool-down.
- Spot / preemptible instances are great here — jobs are idempotent and can re-run cheaply.
- Per-track wall clock target: <5 min for the full ladder.

### 7.4 Idempotency, retries, backpressure

- Every worker keys its work by `(track_id, version, stage)`. Re-processing is safe.
- Retries with exponential backoff up to N=5; after that → DLQ, alert on-call.
- **Per-publisher concurrency cap** so one big label dropping 5K tracks doesn't starve indie artists. Implement with a simple Redis token bucket per publisher_id.
- **Versioning on derived assets** — if you change encoding settings, bump `/v1/` → `/v2/`, kick off re-transcode in batches with rate limit, then flip the manifest URL atomically.

### 7.5 Edge cases you should mention unprompted

- **Duplicate uploads** — fingerprint dedup before transcoding, point new track row at existing derived assets.
- **Takedowns / DMCA** — separate workflow: status → REMOVED, invalidate CDN paths, remove from search index, keep an audit log. CDN invalidation is the slow bit (minutes).
- **Metadata edits after publish** — small (title typo) → just update Postgres + reindex. Big (re-master uploaded) → re-run pipeline as a new version, swap atomically.
- **Region restrictions** — `available_regions` field on the track; playback service rejects if user's IP-derived region not in list. Search filters too.
- **Explicit content** — `explicit` flag, family-account filter at playback.
- **Quotas** — daily upload count per publisher, surface a clear error when exceeded.

---

## 8. Cross-cutting: caching, queues, observability

### Caching (where each layer earns its keep)

| Layer | What it caches | TTL | Why |
|---|---|---|---|
| Player buffer | Next ~30s of audio | n/a | Smooth playback over jitter |
| CDN edge | Audio segments, manifests, images | 30d / 1m / 30d | Crushes origin egress |
| Redis (hot) | Track metadata for top 10K tracks, autocomplete, session | 5m–1h | Reads vastly outnumber writes |
| Postgres buffer | Working set in shared_buffers | n/a | Postgres internals |
| App in-process | Per-request memoization (e.g., user tier lookup) | request | Avoid N+1 |

### Queues / event bus

- **Kafka** is the right answer if you're going to grow plays/events into the billions. SQS+SNS is fine and operationally simpler if you're staying small.
- Topics: `upload.completed`, `transcode.complete`, `fingerprint.result`, `catalog.changes`, `play.events`, `dmca.takedown`.
- Exactly-once isn't worth it; **at-least-once + idempotent consumers** is the pragmatic answer.

### Observability

- **RED** metrics per service (rate, errors, duration).
- Dashboards: p50/p95/p99 manifest latency, p99 first-byte audio, search p99, transcode wall-time SLO (<5 min for 95%), upload-to-live SLO (<1 hr for 99%).
- Trace context through API → playback → S3 → CDN. CDN logs via real-time logs to a stream → ClickHouse for cache-hit-rate dashboards.
- Per-track play counts as a slow-changing dimension, refreshed nightly.
- **Alarms tied to SLOs**, not raw thresholds.

---

## 9. Week 1 vs defer

**Week 1 (must ship):**
- S3 + CloudFront + signed URLs + HLS at 128 kbps only (one bitrate to start, ladder follows fast).
- Postgres for catalog + users.
- OpenSearch managed cluster, basic ranking by popularity + exact-match boost.
- Direct-to-S3 multipart upload, async processing pipeline with FFmpeg workers on ECS, SQS as the queue.
- Single origin region (us-east), CDN globally.
- One mobile platform + web; the other follows.
- Auth via JWT, basic rate limiting.

**Defer to weeks 2–N:**
- Multi-bitrate ladder (add 96 + 256 kbps).
- EU origin replica + origin failover on CDN.
- Fingerprinting via licensed service (ACRCloud-style) — until you have any uploads worth checking against.
- Personalization re-ranking, semantic / vector search.
- DRM + offline downloads.
- Lossless tier.
- Multi-CDN.
- Recommendations, social, podcasts.
- Real-time analytics; nightly batch is fine at this scale.

The story to tell: **"I'd ship the smallest thing that proves the loop — publisher uploads, track plays globally, search finds it. Then add quality (bitrates, DRM), reach (multi-region), and intelligence (recs, personalization) once we know what hurts."**

---

## 10. What breaks first under load (the "honest trade-offs" answer)

Order them by likelihood:

1. **Origin egress bill, not capacity** — if CDN hit rate drops (lots of long-tail catalog activity, e.g., new release of a backlog), origin egress jumps and so does the bill. Mitigation: pre-warm hot tracks, increase TTLs, content-address segments so you never invalidate.
2. **Transcoder backlog on release windows** — Friday midnight, every label drops. Fix: pre-emptible worker fleet that scales fast on queue depth, per-publisher concurrency caps so the big drops don't starve indie artists.
3. **Search latency under bursty fuzzy queries** — a cached typeahead with high hit rate masks this; uncached deep fuzzy queries with wildcards are the killer. Fix: ban leading wildcards at the API, cap fuzziness, separate node pool for typeahead.
4. **Postgres connection pool** — N+1 lookups in the playback service when a curated playlist hits a new release. Fix: PgBouncer in transaction-pooling mode, batch lookups, cache hot rows in Redis.
5. **Indexer lag during catalog imports** — bulk publisher imports overwhelm the indexer. Fix: priority queues (new releases first), bulk batching, scale indexer pods on Kafka consumer lag.
6. **Hot S3 prefix on a viral release** — too many requests to the same key prefix. Fix: content-addressed paths (UUID-prefixed), CDN absorbs almost all of it anyway.

---

## 11. The closing pitch (interviewer asks "what would you do differently?")

Three honest answers ready to go:

- **"I'd actually start with progressive download, not HLS, and migrate."** Defensible if interviewer values speed-to-MVP. The ABR upside doesn't pay off until you have measured stalls in the field.
- **"I'd buy fingerprinting, not build it."** Audible Magic / ACRCloud as a managed service. Building a fingerprint DB is a multi-quarter project and gets you nothing publishers care about.
- **"I'd treat the play_event pipeline as a separate problem."** Plays are append-only, columnar, queried as aggregates — they belong in ClickHouse / BigQuery, not your transactional store. Mention this even if you didn't go deep on analytics.

---

## 12. Common interviewer follow-ups (rehearse 30s answers)

- *"Walk me through what happens when a user in Berlin presses play on a track uploaded an hour ago in NYC."* → manifest fetch, signed URL, CDN miss in EU pop, origin pull from us-east (or eu-west replica), edge cache fill, segment serve, ABR. Mention pre-warming if it's a hot release.
- *"How do you keep search fresh?"* → CDC from Postgres → Kafka → indexer → OpenSearch. Lag target <60s, monitored. Backfill via scheduled job.
- *"How do you prevent a user from sharing a track URL with the world?"* → short-expiry signed URLs (15 min), tied to user via session cookie or signed query param. Also rate limit per user.
- *"How do you handle a viral spike — one track gets 100× normal traffic?"* → CDN absorbs almost all of it (immutable, cacheable). Origin sees one request per edge POP. Worst case: origin pull → S3 scales transparently. App layer sees zero impact because playback service isn't on the audio path.
- *"How would you add recommendations later?"* → log play events to ClickHouse → train collaborative filtering + content embeddings nightly → store user→track scores in a feature store (DynamoDB / Redis) → recs service queries at request time. Mention vector search (pgvector / Pinecone) for "more like this".
- *"What if the transcoder fails for a specific track?"* → DLQ + alert, publisher portal shows FAILED with error code, retry button kicks off a new processing version. Track row stays DRAFT until READY.

---

## 13. Things to NOT do in the interview

- Don't draw before you've scoped. They literally told you this in the brief.
- Don't reach for Kafka, Cassandra, Spark, Flink, etc., unless you can defend each. SQS + Postgres + OpenSearch + S3 + CloudFront is a credible startup stack and won't earn skepticism.
- Don't over-engineer multi-region. 1M users is single-region-with-CDN territory unless they ask.
- Don't promise consistency you can't deliver. Search is eventually consistent. Plays are at-least-once. Be explicit.
- Don't gloss over the upload pipeline — it's the area most candidates skip and most interviewers love.
- Don't forget cost. "What does this cost a month?" is the senior-engineer question. Have a rough $X/mo number ready (~$30–50K/mo all-in for 1M MAU at this design, dominated by CDN + storage).

---

## 14. Self-quiz (do this Day 3)

Time yourself, no notes:

1. Sketch the high-level architecture in 90 seconds.
2. Explain the upload-to-live flow end-to-end in 2 minutes.
3. Justify HLS vs progressive in 60 seconds.
4. Explain why CDC over dual-write in 30 seconds.
5. Name three things that break first under load.
6. Give the back-of-envelope storage and egress numbers without looking.
7. Name three things you'd defer past week 1.
8. Walk through what changes if scale goes from 1M to 100M users.

If any of these feels shaky, re-read that section.
