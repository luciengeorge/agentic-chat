---
title: Reciprocal rank fusion
type: graded
slots:
  search/rrf: rrf.ts
---

# Reciprocal rank fusion

👨‍💼 For Leo's question about KPC-2026-0142, BM25 ranks the Ashgrove MSA first and the vectors rank it 10th. For Rachel's hotel question, the vectors find the hotels clause first and pg_search ranks it 4th. Neither list is right every time, so retrieval keeps both and merges them before the reranker sees 30 chunks. The merge can't compare their scores, which are on different scales. It compares places.

## Terms

- A **ranked list** is search results in order; an id's **rank** is its place, counted from 1.
- **Fusion** merges several ranked lists into one.
- **Reciprocal rank fusion (RRF)** gives an id `1 / (k + rank)` from each list it appears in, and adds them. `k` is 60. An id in no list gets nothing from it.
- **Score blending** (the thing RRF avoids) adds or averages the raw scores, which only works when they share a scale.

## Do this

🐨 In `playground/rrf.ts`, write `rrf`. It's short, and every line has a reason; the hints give them.

## A worked example

Leo's question, 40 chunks from each list (as retrieval takes them), over Kestrel's recorded chunks:

| chunk                      | BM25 rank | vector rank |                   RRF |
| -------------------------- | --------: | ----------: | --------------------: |
| contract register, chunk 7 |         4 |           3 | 1/64 + 1/63 = 0.03150 |
| contract register, chunk 6 |         9 |           1 | 1/69 + 1/61 = 0.03089 |
| Ashgrove MSA, chunk 0      |         1 |          10 | 1/61 + 1/70 = 0.03068 |

A chunk both lists rank well beats one that tops a single list. The MSA comes third, inside the 30 the reranker reads, and lifting it to first is the reranker's job (section 08).

Add the raw scores instead and the vectors vanish: the MSA's BM25 of 22.17 against its cosine of 0.50, so the order is simply BM25's.

Run the tests with `pnpm ex test 07.5`.
