---
title: The golden set
type: graded
slots:
  eval/metrics: metrics.ts
---

# The golden set

👨‍💼 Kestrel changes its retrieval most weeks: a chunk size, a rewrite prompt, a reranker setting. Any of them can make some answers worse without anyone noticing, until the CFO gets the wrong number. So the team keeps a golden set: 46 questions, each asked as a real user, each with the pages that answer it. `pnpm eval` asks every question and scores the ranking against those pages. Before any score, it has to decide which chunk found which page. That's this step.

## Terms

- A **label** is `{ path, page }`: a document and the page that answers. `page` is null for markdown and Word documents, which have no pages.
- A **chunk** covers `pageStart` to `pageEnd`: one page, a range (3 to 4), or null for markdown and Word.
- A chunk **hits** a label when it's from the labelled document and its pages include the label's page. A label with no page is hit by any chunk of its document.
- **Judging** a ranking gives each chunk, in rank order, the index of the label it finds, or null. Each label is found once, by the highest chunk that hits it.

## Do this

🐨 In `playground/metrics.ts`, write `hitsLabel` and `judge`.

## A worked example

Daniel Reyes, Kestrel's CFO, asks "What enterprise value is the board asked to approve for Project Heron, and how is the completion cash funded?". Three pages answer: the Heron board memo's pages 1 and 3 (labels 0 and 1), and page 1 of the September exec offsite notes (label 2). The 14 October run's top 10:

| Rank | Chunk                               | Finds                                |
| ---- | ----------------------------------- | ------------------------------------ |
| 1    | Board Pack, p. 3                    | nothing                              |
| 2    | Heron memo, p. 1                    | label 0                              |
| 3    | Board Pack, pp. 3-4                 | nothing                              |
| 4    | Heron Integration Plan (Word)       | nothing: it has no page to match     |
| 5    | Offsite notes, pp. 1-2              | label 2: page 1 is inside 1 to 2     |
| 6    | Heron memo, p. 3                    | label 1                              |
| 7-9  | Board Pack p. 1, memo pp. 4-5, p. 2 | nothing                              |
| 10   | Heron memo, p. 1 again              | nothing: label 0 was found at rank 2 |

So `judge` gives `[null, 0, null, null, 2, 1, null, null, null, null]`. The last test runs your `judge` over all 46 questions of that report and checks every column against the one the report recorded.

Run the tests with `pnpm ex test 18.1`.
