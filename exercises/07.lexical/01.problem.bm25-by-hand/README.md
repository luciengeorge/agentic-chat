---
title: BM25 by hand
type: graded
slots:
  search/bm25: bm25.ts
---

# BM25 by hand

👨‍💼 Leo Martin types "KPC-2026-0142" into the assistant. 162 of the 434 chunks share at least one piece of it with him: every chunk that mentions 2026 does. Which comes first? The one that says "0142" most, relative to how long it is, because "0142" is the piece almost no other chunk has. That's BM25, and pg_search ranks every lexical search in the app with it. Before using pg_search, you'll build the formula yourself.

## Terms

- A **term** is a piece of text the index keeps: here, a lowercased run of letters and digits. "KPC-2026-0142" is three terms: kpc, 2026, 0142.
- **tf** (term frequency) is how many times a term appears in one document (a chunk, here).
- **df** (document frequency) is how many documents hold the term at least once, and **N** how many documents there are.
- **idf** (inverse document frequency) turns df into a weight: high for a rare term, near zero for a common one.
- **Saturation** means each extra mention adds less. `k1` (1.2) sets how fast; `b` (0.75) sets how much a long document is marked down.

## Do this

🐨 In `playground/bm25.ts`, write `idf` and `termScore`. The index (`buildBm25Index`) and the search that sums your terms (`bm25Search`) are already written. The last test runs pg_search over the same 434 chunks and checks that your formula gives its scores.

## A worked example

Over the 434 recorded chunks the average length is 96.6 terms. The three pieces of KPC-2026-0142:

| term |  df |                            idf |
| ---- | --: | -----------------------------: |
| kpc  |  28 |  ln(1 + 406.5 / 28.5) = 2.7254 |
| 2026 | 160 | ln(1 + 274.5 / 160.5) = 0.9971 |
| 0142 |   9 |   ln(1 + 425.5 / 9.5) = 3.8241 |

Chunk 7 of the contract register is 234 terms long and holds kpc 12 times, 2026 17 times and 0142 3 times. Its length norm is 0.25 + 0.75 × 234 / 96.6 = 2.07. So kpc gives 2.7254 × 12 × 2.2 / (12 + 1.2 × 2.07) = 4.9689, 2026 gives 1.9142, and 0142, with only 3 mentions, 4.6052. Total 11.4883, the best of the 162.

pg_search says 11.5122 for the same chunk. The difference is the length: it keeps 234 as 232.

Run the tests with `pnpm ex test 07.1`.
