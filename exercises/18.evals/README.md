---
title: Evals
---

# Evals

Every section so far changed how Kestrel's assistant finds and writes answers, and each change came with tests. A test says the code does what it was written to do. It can't say whether answers got better or worse across the whole corpus. That's an **eval**: a fixed set of questions with known answers, run against the app, scored, and compared with the last run. Without one, a new chunker or a reworded prompt ships on a feeling.

This section builds Kestrel's evals by hand, the way the reference has them: the golden set and its labels, the ranking metrics, faithfulness checked claim by claim, an LLM judge and how far to trust it, and agent tasks graded in CI. The numbers are real. `pnpm eval` ran the golden set on 14 October (recall@10 1.000, MRR 0.931), and the judge and the claim checker were recorded once on gpt-6-luna on 20 October, so nothing here calls a model.

## Terms

- An **eval** runs a fixed set of cases through the app and scores the results, so two versions of the app can be compared on the same cases.
- The **golden set** (`fixtures/golden/questions.yaml`) is Kestrel's: 46 questions, each asked as a real user of the world, each with what a right answer rests on.
- A **label** is a page that answers a question: a document's path and a page number (no page for markdown and Word documents). Never a chunk id, since chunk ids change whenever chunking does.
- Retrieval returns a **ranking**: chunks, best first. **Rank** 1 is the top.
- **recall@k** is the share of a question's labels found in the top k chunks.
- **MRR** (mean reciprocal rank) is 1 over the rank of the first chunk that finds a label, averaged over the questions.
- **NDCG@k** (normalised discounted cumulative gain) counts each label found as 1, worth less the lower it ranks, and divides by the best score a ranking could get.
- An answer is **faithful** when every claim in it is backed by the sources the model was given. That isn't the same as right (a source can be wrong) or complete (an answer can skip half the question).
- A **claim** is one fact in an answer that is true or false on its own.
- A **judge** is a model call that reads the sources and an answer, and says faithful or unfaithful.
- **Hand labels** are a person's verdicts on a small set: `fixtures/golden/faithfulness.yaml`, 20 answers to four recorded chat turns, 8 faithful and 12 not.
- **Cohen's kappa** says how much better than luck two raters agree: 1 when they always agree, 0 when luck would do as well.
- An **agent task** is a scripted request with checks on what a good run does, graded from the run's event log.

## The steps

1. **The golden set** (`eval/metrics`: `hitsLabel`, `judge`). Which chunk finds which labelled page, each page once.
2. **recall@k, MRR and NDCG** (`eval/metrics`: `recallAtK`, `reciprocalRank`, `ndcgAtK`). Three numbers from one ranking, and what each one can't see.
3. **Claim decomposition** (`eval/claims`: `checkClaims`, `scoreClaims`). An answer split into claims, each checked against the sources it cited.
4. **Judge calibration with Cohen's kappa** (`eval/kappa`: `observedAgreement`, `chanceAgreement`, `cohensKappa`). How far to trust the judge, measured against hand labels.
5. **Agent task evals in CI, compared with autoevals** (guided). Grading what an agent did, and what a ready-made library would give you instead.

Nothing here needs the stack running: the steps read the committed reports and replay the recordings. The lab, `/labs/evals`, is the eval dashboard: every `pnpm eval` run rescored by your metrics, the judge and the claim checker against the hand labels, and the agent tasks, all on your code while a step is active.
