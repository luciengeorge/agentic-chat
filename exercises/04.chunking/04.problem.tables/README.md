---
title: Table-aware chunking
type: graded
slots:
  chunk/chunk: chunk.ts
---

# Table-aware chunking

👨‍💼 Tom Whitfield asks "when does the Ostrander tax advice contract end, and what does it cost?" The contract register has the answer in one row. But the chunker cut that row in two: his name went in one chunk, and "31/10/2026 | Fixed | £80,000 fixed fee" in the next, with no column names to say what the numbers are.

## Terms

- A **row** is one line of a markdown table: `| KPC-2026-0301 | Ostrander Tax Advisers LLP | ... |`.
- The **header** is the table's first two lines: the column names, then the `| --- |` line under them.
- A **repeated header** is the header written again at the top of every chunk that holds rows of the table.

## Do this

🐨 Write `tableRows` in `playground/chunk.ts`: turn a table's markdown into one unit per row, each carrying the header and its token count. `cost`, `build` and `pack` already use what you return; the 🦉 hints say how.

## A worked example

Page 5 of the contract register is a heading and one table of 12 contracts, at the defaults (512 and 64).

Before this step, the table is text. It has no full stops, so it's one long "sentence" that `pieces` cuts between words. The cut lands after "Tom Whitfield", inside the row for KPC-2026-0301, and the second chunk starts "| 15/06/2026 | 31/10/2026 | Fixed | £80,000 fixed fee |" with no header.

With rows as units, the header costs 40 tokens. The first row costs 53 + 1 for its join + 40 for the header it opens: 94. After seven rows the running total is 499. The next row, KPC-2026-0301, costs 54: 553, over 512, so the first chunk closes at 492 tokens. The overlap carries the KPC-2026-0298 row (43 + 1 = 44 tokens; the row before it would make 118). The second chunk starts with the header again, then that row, then KPC-2026-0301 whole: 417 tokens.

Run the tests with `pnpm ex test 04.4`.
