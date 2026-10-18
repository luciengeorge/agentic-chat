---
title: Rerank and query
---

# Rerank and query

Sections 06 and 07 built two searches and fused them. Fusion is good at finding: on the golden set, every labelled page is somewhere in the top 60. It's less good at ordering, because it only knows where each search ranked a chunk, never what the chunk says. This section works on both ends of a search. At the end, a reranker reads the question and each candidate together and puts the answer first. At the start, the question itself is reworked before anything is searched.

Two of the four techniques here don't win on Kestrel's corpus. You'll build them anyway, measure them, and see why. Knowing when a well-known trick doesn't pay is half the job.

## Terms

- A **candidate** is a chunk search found that the viewer may read. **Fused order** is the order RRF put them in (section 07).
- A **reranker** scores each candidate against the question and reorders them. A **cross-encoder** reranker (Cohere's, here) reads the question and the chunk side by side, the librarian who opens each book instead of reading the spines. It's far more accurate than comparing vectors, and far too slow to run on the whole corpus.
- **Depth** is how many candidates the reranker reads. **k** is how many come back (8 for the chat). RRF's `k` in section 07 is another thing: 60, a constant inside the fusion formula, which says nothing about how many results come back.
- **Query rewriting** asks a model for other wordings of the question; **expansion** searches all of them.
- **HyDE** (hypothetical document embeddings) asks a model to write a made-up answer, and searches with that.
- **Routing** picks the few documents a question is about, then searches only inside them.
- **Recall@10** is the share of the golden set's labelled pages found in the top 10 (section 18 builds it).

## The steps

1. **Rerank depth** (`rerank/rerank.ts`). Call Cohere through the AI SDK's `rerank()`, and rerank the first 30 candidates, not the first 8.
2. **Query rewriting and expansion** (`query/rewrite.ts`). Ask for three rewrites as structured output, and clean them.
3. **HyDE** (`query/hyde.ts`). Write the hypothetical passage and embed it. On this corpus it costs a label.
4. **Document-level routing** (`query/route.ts`). Rank document cards by words and meaning. On this corpus it costs three.

Nothing in these tests calls a model or Cohere: the steps replay calls recorded once against the dev stack, with real embeddings. The lab, `/labs/rerank`, runs one live search as you and shows every candidate the reranker read, before and after.
