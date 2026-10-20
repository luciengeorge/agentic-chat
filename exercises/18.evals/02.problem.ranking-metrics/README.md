---
title: recall@k, MRR and NDCG
type: graded
slots:
  eval/metrics: metrics.ts
---

# recall@k, MRR and NDCG

👨‍💼 Step 1 says which chunk found which page. Now the team needs a number per question, and one per run, that goes down when retrieval gets worse. There are three, each answering a different question about the same ranking: did we find the pages at all, how soon did the first one come, and how high did they all rank. Kestrel's `pnpm eval` gates on the first two (recall@10 at least 0.85, MRR at least 0.6) and reports the third.

## Terms

- **recall@k**: the share of a question's labels found in the top k. 2 of 3 labels in the top 5 is 0.667. It doesn't care where in the top k they are.
- **Reciprocal rank**: 1 over the rank of the first chunk that finds any label (rank 2 gives 0.5), or 0 when none does. **MRR** is its mean over questions. It sees only the first find.
- **NDCG@k**: each label found at rank r is worth `1 / log2(r + 1)` (rank 1 is worth 1, rank 3 is worth 0.5). That sum is the **DCG**. Dividing by the **ideal DCG**, what the same number of labels would score in the top places, gives a number from 0 to 1.

## Do this

🐨 In `playground/metrics.ts`, write `recallAtK`, `reciprocalRank` and `ndcgAtK`. Each reads the column `judge` returns: a label index or null per chunk, in rank order.

## A worked example

Daniel's Heron question from step 1 finds its three labels at ranks 2, 5 and 6.

- recall@3 = 1/3 = 0.333, recall@5 = 2/3 = 0.667, recall@10 = 3/3 = 1.
- Reciprocal rank = 1/2 = 0.5.
- DCG@10 = 1/log2(3) + 1/log2(6) + 1/log2(7) = 0.631 + 0.387 + 0.356 = 1.374. The ideal puts three labels at ranks 1 to 3: 1 + 0.631 + 0.5 = 2.131. NDCG@10 = 1.374 / 2.131 = **0.645**.

Over the 40 questions with labels, the 14 October run scores recall@10 **1.000**, MRR **0.931** and NDCG@10 **0.938**. The last test works all three out from the report's rankings with your code.

Run the tests with `pnpm ex test 18.2`.
