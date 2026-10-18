---
title: Query rewriting and expansion
type: graded
slots:
  query/rewrite: rewrite.ts
---

# Query rewriting and expansion: the solution

`modelRewriter` calls `model.object` with `REWRITE_INSTRUCTIONS`, the question as the one user message, the name `search_queries`, the effort it was given and `RewriteSchema`, then returns `cleanRewrites(query, object.queries)`. A failure throws.

`cleanRewrites` seeds a set with the question, trimmed and lower-cased. For each rewrite it trims, skips one that's empty or already in the set (compared in lower case), adds the key, keeps the trimmed text, and stops at three.

## Why it works

- **New words reach BM25.** BM25 scores the words a chunk shares with the query. A rewrite in the document's words ("freeze", "deployment", "release") shares words the question never had.
- **Fusion rewards agreement.** Each rewrite adds two lists. A chunk in many lists gets many small RRF shares, and passes a chunk that topped one list and missed the rest.
- **Nothing is counted twice.** The question has its own two lists already; a rewrite that repeats it, or another rewrite, would add the same two lists again and weigh those hits double.
- **A failure is loud.** If the model is down, retrieval fails. Returning `[]` would answer from fewer searches than the audit and the eval think were made.

## The worked example

Sam Patel's question alone: BM25 doesn't list the freeze table at all, and the vector search lists it first. Fused from those two lists, it's #13. With the three recorded rewrites, it's in 7 of 8 lists and fuses to #4.

## When it doesn't help

On the golden set, where every question already uses the documents' words, rewriting moves little. Run against the dev database on 2026-10-18, it lifted the old expenses policy's page 4 from #2 to #1 and FR-110's row from #5 to #4, and it pushed others down: filing page 845 for complaint CMP-2026-01171 went from #1 to #5, because all three rewrites repeated "complaint CMP-2026-01171", which every page of the filing's complaints register matches. The reranker (step 1) put it back on top. So rewriting is insurance for people who don't know the documents' words, paid for with two searches per rewrite and one model call per question, and fusion plus a reranker is what keeps it from hurting.
