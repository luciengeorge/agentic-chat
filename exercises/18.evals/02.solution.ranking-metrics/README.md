---
title: recall@k, MRR and NDCG
type: graded
slots:
  eval/metrics: metrics.ts
---

# recall@k, MRR and NDCG: the solution

`recallAtK` refuses fewer than one label (a `RangeError`, from `requireLabels`, which `ndcgAtK` shares), then counts the non-null entries of `judged.slice(0, k)` and divides by the label count. `reciprocalRank` finds the first non-null index and returns `1 / (index + 1)`, or 0. `ndcgAtK` adds `1 / log2(i + 2)` for every hit at index `i` in the top k (rank `i + 1`), and divides by the same sum over ranks 1 to `min(labelCount, k)`.

## Why it works

- **Three questions, three numbers.** recall@k asks "were the pages there?", reciprocal rank "how soon was the first?", NDCG "how high were they all?". Each is blind where another sees: recall ignores order, reciprocal rank ignores every label after the first, and NDCG blends both into one number that's harder to read on its own.
- **The discount.** `1 / log2(rank + 1)` falls quickly at the top (1, 0.63, 0.5) and slowly lower down (0.29 at rank 10), roughly as attention does. The + 1 makes rank 1 worth exactly 1 and keeps rank 1 from dividing by log2(1) = 0. The base of the logarithm doesn't matter to NDCG: every discount scales by the same factor in another base, and the ratio to the ideal cancels it. A natural log gives the same 0.645. log2 is the convention because it makes rank 1 worth exactly 1 in the DCG itself.
- **The ideal.** Dividing by the best score the same number of labels could get makes every question score from 0 to 1, whether it has one label or three. Capping the ideal at k is what lets a ranking be perfect when there are more labels than places.
- **Averages hide.** The run's MRR is 0.931 because 35 questions find a label first, four at rank 2 and one at rank 4 (37.25 over 40). A run's number says something moved; the per-question rows say what.

## The worked example

Daniel's labels at ranks 2, 5 and 6: recall@3 = 0.333, recall@5 = 0.667, recall@10 = 1; reciprocal rank 0.5; NDCG@10 = (0.631 + 0.387 + 0.356) / (1 + 0.631 + 0.5) = 1.374 / 2.131 = 0.645.

The four questions at rank 2 are worth a look in the lab. Rachel Obi's London hotel question and Leo Martin's meals question both rank version 1 of the expenses policy above version 2: the old page answers the question too, just wrongly now. That's the conflicting-sources trap, the lowest trap in the run (MRR 0.75). Lena Fischer's fraud rule question is the one at rank 4. All 40 still have recall@10 1: every labelled page is in the top 10, and in fact in the top 6, so the app's k of 8 sees them all.
