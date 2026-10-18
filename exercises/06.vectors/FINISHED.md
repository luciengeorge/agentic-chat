---
title: Embeddings and vectors, done
---

# Embeddings and vectors, done

Your code now embeds chunks in batches of 256, each vector back on its own chunk. The app's vector search walks the HNSW index with an `ef_search` of at least the page size, and keeps walking when the tenant or the ACL filter throws the nearest chunks away. You can measure what that walk misses against an exact scan, and you've seen the three ways to make vectors smaller: fewer dimensions (truncation), fewer bytes per number (halfvec) and one bit per number, won back by rescoring.

## What to notice in the lab

Open `/labs/vectors` and press Run with "Dev corpus" (any user can see it). It copies the corpus's 5,637 distinct vectors into a scratch database and runs every variant through your code, about ten seconds. One run on 18 October gave:

- **The exact scan** at 100% in 17.6 ms, top left of the chart: always right, ten times slower than anything else.
- **HNSW** climbing with `ef_search`: 75.9% at 10, 88.5% at 40, 94.3% at 100 (the app's setting), 95.9% at 200, from 1.2 to 1.9 ms. Run it twice: those numbers move a few points, because each build is random.
- **Truncation** costing more than it saves: 62.0% at 256 dimensions, 84.8% at 1,024, whose index is still 44 MB (a 4 KB vector still takes a whole 8 KB page).
- **halfvec** matching full vectors (94.3%) at half the index, 22 MB.
- **Bits**: 65.2% alone from a 2.7 MB index, 86.5% with 200 rescored.

Switch to "The recording" to see why small tests can't show this: on 428 vectors nearly every variant finds nearly everything.

## What comes next

Section 07 builds the other half of search, by exact words, where vectors fail on contract numbers and error codes, and merges the two lists. Section 08 reranks the merged list, which is why HNSW only has to put the right chunk somewhere in the first 40, not first.
