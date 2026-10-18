---
title: Rerank depth
type: graded
slots:
  rerank/rerank: rerank.ts
---

# Rerank depth

👨‍💼 Sofia Lindqvist, Kestrel's compliance officer, asks: "What did the Financial Ombudsman Service decide on complaint CMP-2026-01171?" Two documents answer her: page 845 of the FCA filing, and page 3 of the Q2 Compliance Monitoring Report. Search finds both. But the report's page comes 27th, behind 26 pages of the filing's complaints register, and the assistant only shows its top 8.

## Terms

- A **candidate** is a chunk search found and the viewer may read. **Fused order** is the order fusion (section 07) put them in.
- A **reranker** scores each candidate against the question. Ours in the app is Cohere's `rerank-v4.0-fast`, a **cross-encoder**: a model that reads the question and the chunk together, instead of comparing two vectors made apart. In tests it's the **overlap reranker**: the share of the question's words a chunk holds.
- The **depth** is how many candidates, from the top of the fused order, the reranker reads (30 by default). **k** is how many it hands back (8).
- `rerank()` is the AI SDK's call for any reranking model. It returns a `ranking`: the best documents first, each with its `originalIndex` (its place in the list you sent) and its `score`.

## Do this

🐨 Write two functions in `playground/rerank.ts`:

1. `aiSdkReranker`'s `rerank`: call the AI SDK's `rerank()` and turn its ranking into `{ index, score }`.
2. `rerankCandidates`: rerank the first `depth` candidates, and return the best `k` of them, whole, with their scores.

`overlapReranker` is written, and `retrieve` already calls `rerankCandidates` with the depth and k from its settings.

## A worked example

Sofia's question, plus three rewrites, made 8 searches (BM25 and vector for each). Fused, they gave 60 candidates, all of them Sofia's to read. The first 26 are tables from the filing's complaints register, pages 797 to 865, full of complaint references like hers. #27 is the report's page 3, its complaints section. #28 is the foot of filing page 845: the paragraph that says the Ombudsman upheld CMP-2026-01171 and Kestrel refunded £3,850.00.

| Depth | What Cohere reads | Its top two                         | Do #27 and #28 come back? |
| ----- | ----------------- | ----------------------------------- | ------------------------- |
| 30    | #1 to #30         | #28 (score 0.962), then #27 (0.911) | yes, 1st and 2nd          |
| 8     | #1 to #8          | #6, then #1: two register tables    | never                     |

Run the tests with `pnpm ex test 08.1`. They replay Cohere's recorded answers, so nothing calls out.
