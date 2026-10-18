---
title: HNSW and filtered search
type: graded
slots:
  vectors/hnsw: hnsw.ts
  search/vector: vector.ts
---

# HNSW and filtered search: the solution

`hnswIndexSql` checks the knobs (m from 2 to 100, ef_construction from 2 × m to 1,000), then writes `CREATE INDEX <name> ON <table> USING hnsw (<column> <ops>) WITH (m = .., ef_construction = ..)`, every name through `identifier`.

`vectorSearch` sets `hnsw.ef_search` to the larger of the option and the limit, turns on `hnsw.iterative_scan = relaxed_order`, both with `SET LOCAL`, and runs one query: a MATERIALIZED CTE that orders the chunks of the listed documents and model version by `embedding <=> query` with the limit, then sorts those rows again by distance and id. The score is 1 minus the distance.

## Why it works

- **The filter runs after the walk.** The HNSW index knows nothing of tenants or ACLs. A plain scan hands back its `ef_search` nearest, and only then do the WHERE clause and RLS throw out what the viewer can't see. When the nearest belong to someone else, that's everything.
- **The iterative scan keeps walking.** When too few rows survive the filter, it fetches the next candidates outwards from where it stopped, until the limit is met (or `hnsw.max_scan_tuples`, 20,000 by default, is reached). So a small tenant, or a user who can read three documents, still gets a full page.
- **Relaxed order is fast, and the outer sort fixes it.** In `relaxed_order` mode pgvector may return a later candidate before an earlier one. The CTE is MATERIALIZED, so its rows are fixed before the outer `ORDER BY distance, id` puts them right.
- **Settings end with the transaction.** `SET LOCAL` dies with it. A plain `SET` would stay on the pooled connection, and the next request to borrow it would search with your settings.
- **m and ef_construction are build-time.** Changing them means rebuilding the index. ef_search is per query, which is why the app keeps it in code (100) and can raise it for a hard search.

## The worked example

Nina's question at Harbour: a plain scan at ef_search 40 returns 0 chunks, because the 158 nearest are all Kestrel's. With the iterative scan: 10 Harbour chunks, the best Harbour's procurement process at 0.2718 against Kestrel's price list at 0.6861, so the model sees that nothing Harbour has is about KC-PRO-12 and says it can't find it. Rachel's hotel question at Kestrel: the hotels clause of the expenses policy v2 first, at 0.6885.

Postgres does the filtering in the same statement as the search, inside the tenant's transaction. That's the point of keeping vectors next to the rows: no separate vector store has to be told what each user may see.
