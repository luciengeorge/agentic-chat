---
title: Rerank depth
type: graded
slots:
  rerank/rerank: rerank.ts
---

# Rerank depth: the solution

`aiSdkReranker`'s `rerank` returns `[]` for no documents. Otherwise it calls the AI SDK's `rerank()` with the model, the query, the documents, `maxRetries` and `topN` capped at the number of documents, and maps each entry of the `ranking` to `{ index: entry.originalIndex, score: entry.score }`, keeping the ranking's order.

`rerankCandidates` slices the first `depth` candidates into a pool, sends the reranker the pool's text and `k`, and returns `{ ...pool[index], score }` for each entry it gets back.

## Why it works

- **The index points into what you sent.** Cohere returns the best documents first, each tagged with its place in the request. Looking the chunk up by that tag gives each score to the right chunk. Its place in the ranking is already the order of the list you return.
- **The depth decides what can come back.** A reranker can only reorder what it reads. Rerank the first 8 and return 8, and the most it can do is shuffle them; a chunk at #27 has no way up. Read 30 and return 8, and any of the 30 can reach the top.
- **The pool keeps fused order.** The first `depth` candidates are the ones fusion liked best, so the depth cuts the least likely ones first.
- **Each result is the candidate, whole.** `retrieve` returns these as they come back: id, document, title, path, pages, section and text, with the reranker's score as the chunk's score.

## The worked example

Sofia Lindqvist's question about complaint CMP-2026-01171 gave 60 candidates. The fused order put 26 complaints-register tables from the FCA filing first, the Compliance Monitoring Report's page 3 at #27, and the paragraph at the foot of filing page 845 that holds the decision at #28.

At depth 30, Cohere read all of them and ranked #28 first (0.962) and #27 second (0.911); the other six of its top 8 are register tables, at 0.665 or less. The test's overlap reranker, which only counts the question's words in each chunk, also lifts the report to the top two. At depth 8, Cohere read only the first eight tables. Its best were #6 (page 846's table) and #1 (page 845's, which lists other complaints), and neither the decision nor the report came back.

Cohere's trial key bills nothing, but a paid one counts a search unit per query and 100 documents, so depth 30 costs what depth 8 does. What depth costs is time, and what a third party reads. Section 09 makes sure every candidate it reads is one the viewer may.
