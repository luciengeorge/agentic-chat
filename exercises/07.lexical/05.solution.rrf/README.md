---
title: Reciprocal rank fusion
type: graded
slots:
  search/rrf: rrf.ts
---

# Reciprocal rank fusion: the solution

`rrf` keeps a `Map` from id to total. For each list it keeps a `Set` of ids already seen in that list, and for each new id at 0-based index i adds `1 / (k + i + 1)`. Then it turns the map into `{ id, score }` entries and sorts them by score, highest first. The sort is stable and the map remembers insertion order, so ties keep the order the ids were first seen.

## Why it works

- **Ranks are comparable when scores aren't.** BM25 scores grow with the number and rarity of matching terms; cosine similarities sit between 0 and 1. A rank means the same in both lists.
- **Agreement wins.** 1/61 for first place and 1/70 for tenth are close, so being in both lists counts for more than being first in one. Two lists that each found a chunk are better evidence than one list that loved it.
- **Nothing found by one list is lost.** The union of the lists goes forward. A chunk only BM25 found (the identifier case) still scores 1/(60 + rank), enough to reach the reranker if its rank is good.
- **A duplicate counts once.** The same id twice in one list would otherwise be counted as if two searches agreed.
- **Order is stable.** Equal totals keep first-seen order, so the same lists always fuse into the same ranking.

## The worked example

Register chunk 7 (ranks 4 and 3) at 0.03150, register chunk 6 (9 and 1) at 0.03089, the MSA (1 and 10) at 0.03068. The fused list is a list of candidates, not the answer: all three reach the reranker, which reads each one against the question.

Retrieval does this for every question and each rewrite, two lists each (`createRetrieve` in `src/core/retrieve/retrieve.ts`), and keeps 60 fused candidates for the ACL check.
