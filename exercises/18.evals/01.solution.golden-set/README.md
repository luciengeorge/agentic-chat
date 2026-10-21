---
title: The golden set
type: graded
slots:
  eval/metrics: metrics.ts
---

# The golden set: the solution

`hitsLabel` checks the document first: another path never hits. A label with no page is hit by any chunk of its document. A paged label needs a paged chunk, and the page must fall inside `pageStart` to `pageEnd ?? pageStart`.

`judge` walks the chunks in rank order with a set of the labels found so far. For each chunk, `findIndex` looks for the first label that is both not yet found and hit; that index takes the chunk's place and joins the set. No such label: null.

## Why it works

- **A page outlives the chunker.** The golden set was labelled once, by reading the PDFs. Every change to chunking since (sizes, overlap, headings, tables) moved the chunk boundaries, and the labels still hold, because they say where the answer is, not which piece of text held it.
- **Ranges matter.** A chunk that runs over a page break holds the end of one page and the start of the next. Comparing only `pageStart` would credit it for its first page and miss its second.
- **Found once.** Skipping found labels before choosing means a chunk spanning two labelled pages finds the second when the first is taken, and a repeat of a found page finds nothing. So no ranking can score by repeating one page.
- **The judge is all the metrics know.** recall@k, MRR and NDCG (step 2) read only this column of indexes and nulls. Any mistake here moves every score.

## The worked example

Daniel Reyes's Heron question, judged: `[null, 0, null, null, 2, 1, null, null, null, null]`. The Board Pack at rank 1 talks about Heron but isn't a labelled page. The integration plan at rank 4 is a Word file, so it can't hit a paged label. The offsite notes at rank 5 cover pages 1 to 2 and find label 2 (page 1). The memo's page 1 comes back at rank 10 and finds nothing, since rank 2 found it.

Across the 14 October report, your `judge` gives the column the run recorded for all 40 questions with labels. The other 6 are abstain cases: their users can't read anything that answers, so there's nothing to find.
