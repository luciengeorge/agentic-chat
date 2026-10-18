---
title: Exact vs approximate
type: graded
slots:
  vectors/recall: recall.ts
---

# Exact vs approximate: the solution

`exactNearest` runs `SET LOCAL enable_indexscan = off` and `SET LOCAL enable_bitmapscan = off`, then the shared `nearest` query. With both off, the planner's only way to answer `ORDER BY embedding <=> $1 LIMIT k` is a sequential scan: every distance, then a sort.

`recallAtK` takes the first k of the truth (refusing an empty one) and the first k of what was found, counts how many true ids are among those found, and divides by the number of true ids.

## Why it works

- **The truth can't come from the thing being measured.** The SQL for exact and approximate search is the same; only the plan differs. Leave the index available and, on any table big enough to matter, the planner walks the graph, and you'd be measuring HNSW against itself.
- **SET LOCAL keeps it to this transaction.** The next query on the connection gets its index back.
- **Recall is a set comparison.** Order inside the top k doesn't count against it: the reranker reorders candidates anyway. Only what was found in the first k counts, against how many there were to find.
- **Recall depends on the data as much as on the knobs.** The same default graph finds all of the true neighbours among 428 vectors and three quarters of them among 5,637. More vectors, packed tighter (most of the filing's 5,274 chunks are daily schedules that differ by a date and a few figures), means more places for a greedy walk to stop short. So the knobs have to be measured on your own corpus, at its real size.

## The worked example

On 428 vectors: m 4 at ef_search 10, about 87%; at ef_search 100, about 99%; m 16 at ef_search 40, 100%. They move a few points from one build to the next, because each vector's layer in the graph is drawn at random. On the full corpus (the bench): 35.9% for m 4 and 75.9% for m 16, both at ef_search 40; 86.7% at the app's ef_search of 100 in 1.75 ms, against 18.09 ms for the exact scan.

That's why the app searches at ef_search 100, not pgvector's default of 40, and why the reranker sees 30 candidates, not 8: a true neighbour HNSW ranked 15th still reaches it.
