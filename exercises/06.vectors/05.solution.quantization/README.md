---
title: halfvec, bit and rescoring
type: graded
slots:
  vectors/quantize: quantize.ts
  vectors/sizing: sizing.ts
---

# halfvec, bit and rescoring: the solution

`bytesPerVector` is 8 bytes of header plus 4 a dimension for `vector`, 2 for `halfvec`, and `Math.ceil(d / 8)` for `bit`.

`binaryRescoreNearest` checks the dimensions and that `overfetch` is at least `k`, sets `hnsw.ef_search` to the larger of `efSearch` and `overfetch`, switches sequential scans off, and runs one statement: a MATERIALIZED CTE of the `overfetch` rows nearest by `bits <~> B'<question's bits>'`, carrying each row's full vector, then those candidates ordered by `full_vector <=> question` with `LIMIT k`.

## Why it works

- **A page holds one full vector.** Postgres stores an HNSW entry whole, on one 8 KB page. 6,152 bytes leave no room for a second, so the index costs a page per vector whatever `m` is: 44 MB for 5,637. That's why the bench found every `vector(1536)` index the same size, and `vector(1024)` too. halfvec fits two a page and halves it; bits fit dozens.
- **In the table, big values move out of line.** A row value over about 2 KB is stored in the table's TOAST storage (a side table Postgres keeps for large values), and the row keeps a pointer. So a `vector(1536)` column costs its 6,152 bytes there, not in the row, and `pg_table_size` (which counts TOAST) is the number to watch, not the row count times the page size.
- **halfvec loses nothing you can measure here.** 2-byte floats keep about three significant digits, and cosine similarities between chunks differ in the second. The bench's exact scan over `halfvec` found 100% of the full vectors' top 10.
- **Bits are a coarse cosine.** Two vectors that point the same way agree on most signs, so Hamming distance tracks cosine distance roughly. Roughly means ties and near-ties, and the order among them is close to chance: 68% recall alone.
- **Rescoring fixes the order, not the search.** The true neighbours are nearly always in the first few hundred by Hamming distance. Sorting 200 candidates by their full vectors costs 200 reads of 6 KB, not 5,637, and puts the right ones on top.
- **ef_search caps the candidates.** pgvector's HNSW scan returns at most `ef_search` rows, so the over-fetch only happens if ef_search is raised to it.

## The worked example

428 vectors, 429 index pages (3,514,368 bytes) at a page each; bits alone about 81%, 200 rescored 100%. On the full corpus: 2.7 MB of bit index against 44 MB, and 91.7% recall against 86.7% for HNSW over the full vectors. The rescored search is more accurate than the plain one because its candidate list is five times longer, while it reads full vectors for only 200 rows.

The catch: the full vectors still have to be stored (in the table, not the index), and each search reads 200 of them. The index is what must stay in memory, and that's the part that shrank.
