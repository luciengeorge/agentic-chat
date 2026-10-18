---
title: HNSW and filtered search
type: graded
slots:
  vectors/hnsw: hnsw.ts
  search/vector: vector.ts
---

# HNSW and filtered search

👨‍💼 Nina Osei works at Harbour Health, the app's other tenant. She asks "How much does Kestrel Checkout Pro cost a month on KC-PRO-12?". Kestrel's price list answers it, and she must never see it, so the right answer is "I can't find that". But search should still hand the model Harbour's nearest chunks, so it can say so from what Harbour does have. Today's naive vector search hands it nothing at all.

## Terms

- **HNSW** (hierarchical navigable small world) is a graph index: every vector is linked to some of its nearest neighbours, and a search walks the links towards the question. It's **approximate**: it may miss a true neighbour.
- `m` is how many links each vector gets, and `ef_construction` how many candidates the build weighs when it picks them. Both are fixed when the index is built.
- `ef_search` is how many candidates a search keeps while it walks. It's set per query, so the app can trade speed for accuracy at any time.
- The **pre-filter** is the list of documents the viewer may read, worked out before the search (section 09). **RLS** (row-level security) is Postgres hiding every other tenant's rows.
- The **iterative scan** (pgvector 0.8) lets an HNSW search keep walking when its filter leaves too few rows.

## Do this

🐨 Two stubs. In `playground/hnsw.ts`, write `hnswIndexSql`, the statement that builds the index with its knobs. In `playground/vector.ts`, write `vectorSearch`, the query the app runs for every question. The hints in each file say how; the tests need Postgres (`pnpm ex up`).

## A worked example

The test loads the 434 recorded chunks, 375 of Kestrel's and 59 of Harbour's, into one `chunks` table with the app's index (m 16, ef_construction 64). Nina's question is nearest to Kestrel's price list (cosine similarity 0.6861). The 158 nearest chunks are all Kestrel's; Harbour's first is 159th.

A plain HNSW scan at `ef_search` 40 walks the graph and returns its 40 nearest. Then RLS removes every Kestrel row: 0 chunks (sometimes 1, since the build is random). With the iterative scan the walk carries on until 10 Harbour chunks pass. The best of them is Harbour's procurement process at 0.2718 (the walk is approximate, so on some builds it's the next one, the delegated financial authority at 0.2552). That low number is the real answer: nothing Harbour has is about KC-PRO-12.

For Rachel Obi at Kestrel, "What is the nightly limit for a hotel in London?" finds the hotels clause of the expenses policy v2 first, at 0.6885.

Run the tests with `pnpm ex test 06.2`.
