---
title: Identifiers
type: graded
slots:
  search/bm25: bm25.ts
---

# Identifiers

👨‍💼 Contract numbers, error codes, product codes, invoice numbers: Kestrel's staff ask about them all day, and they're exactly what vector search is bad at. "KPC-2026-0142" and "KPC-2026-0298" mean almost the same thing to an embedding. To BM25 they share two terms out of three, and the third decides. This step writes the tool that shows it: a score, split into the part each word contributed.

## Terms

- An **identifier** is a code that names one thing: KPC-2026-0142 (a contract), KP-4031 (an error), KC-PRO-12 (a product).
- An **explanation** of a BM25 score lists every query term with its tf, df, idf and the part of the score it gave. The parts add up to the score.
- A **rank** is a position in a result list, counted from 1.

## Do this

🐨 In `playground/bm25.ts`, write `explainScore`: one document's score, term by term. Your `idf` and `termScore` from step 1 are already in the file.

## A worked example

Leo Martin asks "Who owns contract KPC-2026-0142, and when does its initial term end?". Over the 434 recorded chunks, BM25 ranks the Ashgrove MSA's first page first, at 22.1736. Explained:

| term     |  tf |  df |   part |
| -------- | --: | --: | -----: |
| initial  |   2 |   3 | 6.0591 |
| term     |   3 |  29 | 3.9449 |
| 0142     |   1 |   9 | 3.3624 |
| contract |   2 |  39 | 3.0142 |
| kpc      |   1 |  28 | 2.3964 |
| end      |   1 |  51 | 1.8762 |
| 2026     |   2 | 160 | 1.2527 |
| and      |   2 | 351 | 0.2678 |

("who", "owns", "when", "does" and "its" aren't on the page, so they add 0.) Vector search puts the same page 10th, at a cosine similarity of 0.5030; its top 9 are pages about contracts in general, led by chunk 6 of the contract register.

Ask for the bare number, "KPC-2026-0142", and 7 of BM25's top 10 hold it, against 2 of the vectors' top 10. The vectors' best (0.3955) is a page of the register about other contracts.

Run the tests with `pnpm ex test 07.3`.
