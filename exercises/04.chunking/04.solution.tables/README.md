---
title: Table-aware chunking
type: graded
slots:
  chunk/chunk: chunk.ts
---

# Table-aware chunking: the solution

`tableRows` splits a table into lines. The first two are the header. Every line after them becomes a unit of its own, carrying the header and the header's token count. A table with no rows is one unit, the header, with no header to repeat. The rest of the file already used that: `cost` charges the header to the row that opens a table in a window, `build` writes it there, and rows join with a newline.

This file is now the same as the app's reference, `src/core/chunk/chunk.ts`.

## Why it works

- **A row is a record.** Cutting only between rows keeps each contract's number, owner, dates and value together.
- **The header makes the numbers readable.** "| 15/06/2026 | 31/10/2026 | Fixed | £80,000 fixed fee |" needs its column names to say which date is the end and what the £80,000 is. Every chunk with rows gets them.
- **The header is paid for.** It's written into every chunk that holds rows, so it's counted in every one. A 40-token header leaves 472 tokens of rows in a 512-token chunk.
- **Overlap works on rows too.** `tail` carries whole rows, and `build` puts the header back in front of them.

## The worked example

Page 5 of the contract register at the defaults. Before: the table was one long run of cells, cut after "Tom Whitfield" in the middle of contract KPC-2026-0301. After: the header costs 40 tokens and the first row 94 (53, plus 1 for its join, plus the header). After seven rows the total is 499; KPC-2026-0301's row costs 54 more, so the first chunk closes at 492 tokens. The second starts with the header, then the KPC-2026-0298 row as overlap (44 tokens; one more row would make 118), then KPC-2026-0301 whole: 417 tokens.
