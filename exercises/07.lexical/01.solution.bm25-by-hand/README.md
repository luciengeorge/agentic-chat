---
title: BM25 by hand
type: graded
slots:
  search/bm25: bm25.ts
---

# BM25 by hand: the solution

`idf` is `Math.log(1 + (documents - withTerm + 0.5) / (withTerm + 0.5))`. `termScore` returns 0 for tf 0, and otherwise `idf × tf × (k1 + 1) / (tf + k1 × (1 - b + b × length / averageLength))`.

## Why it works

- **Rare terms decide.** idf grows with the odds against a document holding the term, on a log scale. "0142" (9 chunks) weighs 3.82; "2026" (160 chunks) weighs 1.00; "the" (363) weighs 0.18. So a query's common words barely move the ranking and its rare ones decide it.
- **Repetition helps, then stops helping.** tf / (tf + k1) rises quickly and flattens, so chunk 7's twelve mentions of "kpc" are worth 1.8 times its idf, not twelve times.
- **Length is fair.** A chunk two and a half times the average length needs more mentions for the same credit, since a long chunk mentions more words by accident.
- **idf never goes negative.** The `1 +` inside the log is Lucene's change to Robertson's formula; without it a term in more than half the chunks would lower a chunk's score for holding it.

## The worked example

KPC-2026-0142 over the 434 chunks: 162 match, and the contract register's chunk 7 comes first at 4.9689 + 1.9142 + 4.6052 = 11.4883.

pg_search agrees with your formula to 32-bit precision once two things it does differently are applied, and the test applies both:

- **It keeps each document's length in one byte** (Tantivy's "field norm"): exact up to 40 terms, rounded down to a coarser step above. Chunk 7's 234 terms are stored as 232, which gives 11.5122. That's 256 steps, to cover documents from 0 to millions of terms in a byte per document.
- **It counts a repeated query word every time.** "When can Kestrel break the lease, and by when must notice be given?" has "when" twice, and pg_search scores it twice. `bm25Search` here counts it once.

Neither changes which kind of chunk wins. They matter when you compare scores across systems, and they're why the next step uses pg_search's own index, not this one, for the app.
