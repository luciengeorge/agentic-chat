---
title: Exact vs approximate
type: graded
slots:
  vectors/recall: recall.ts
---

# Exact vs approximate

👨‍💼 Leo Martin asks "Who owns contract KPC-2026-0142, and when does its initial term end?". The vector search finds ten chunks in under 2 ms. Are they the ten nearest of all 5,637, or ten that HNSW happened to reach? Nobody can tell by looking. You can only tell by measuring against the true answer, so this step builds the measuring stick.

## Terms

- **Exact search** computes the distance from the question to every vector and sorts them all. Its top 10 is the **ground truth**: by definition, the true 10 nearest.
- **Approximate search** (HNSW here) walks a graph and looks at only some vectors. It's fast, and it may miss.
- **Recall@k** is how many of the true k nearest the approximate search found in its own first k, as a share. Finding 8 of the true top 10 is a recall@10 of 0.8.
- The **planner** is the part of Postgres that decides how to run a query: read every row (a **sequential scan**), or use an index.

## Do this

🐨 In `playground/recall.ts`, write `exactNearest` (the true top k, with the index out of the planner's reach) and `recallAtK` (the share of the truth found). The tests need Postgres.

## A worked example

For Leo's question, the exact top 3 of the 428 distinct recorded vectors are chunks 6, 8 and 7 of the contract register, at cosine similarities 0.6027, 0.6019 and 0.5854.

Over the 46 golden questions, a coarse graph (m 4, ef_construction 16) searched at ef_search 10 finds about 87% of the true top 10: on average 1.3 of each question's 10 nearest are missed. Raise ef_search to 100 and it finds about 99%. The default graph (m 16, ef_construction 64) at ef_search 40 finds them all, on 428 vectors.

Size changes that. On the full corpus (5,637 vectors, the bench) the default graph at ef_search 40 finds 75.9%, and ef_search 100 finds 86.7% in 1.75 ms. The exact scan takes 18.09 ms. Ten times slower, and always right.

Run the tests with `pnpm ex test 06.3`.
