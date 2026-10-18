---
title: Tables to markdown
type: graded
slots:
  parse/layout: layout.ts
---

# Tables to markdown

👨‍💼 A merchant's integration starts failing with KP-1009, and the on-call engineer asks the assistant what to do. The answer is one row of the Payments API error code catalogue: "Yes, after Retry-After" in the Retry column, and the advice in the last. In the PDF that row is three lines of loose text, and the advice wraps. Read the page line by line, and "endpoints." becomes a row of its own, with no code next to it.

## Terms

- A **point** is how PDFs measure: 1/72 of an inch, about a third of a millimetre. An A4 page is 595 points wide, and **9pt** text is 9 points tall.
- A **segment** is a run of text on one line, with where it starts (`x0`) and ends (`x1`), in points from the left edge.
- A **gutter** is the empty strip between two columns. It's empty on every line of the table.
- A **wrapped line** continues a cell that didn't fit on one line. It sits one line height under the line above.
- **Markdown** writes a table as `| a | b |` lines under a header and a `| --- |` line. `tableBlock` writes it.

## Do this

🐨 Write `tableRows` in `playground/layout.ts`. Find the columns from the segments of every line at once, then group lines into rows by the gap above each one, then put each segment in its row and column. `layoutPage` already finds where a table starts and ends and hands you its lines; `tableBlock` turns your rows into markdown.

## A worked example

Page 1 of the error code catalogue. The table is 14 lines of 9pt (9-point) text:

| Gap down from the line above | Lines     | Means        |
| ---------------------------- | --------- | ------------ |
| 11.2 to 11.3 points          | 8 of them | the same row |
| 15.8 to 16.3 points          | 5 of them | a new row    |

The cut is 1.4 × 9 = 12.6 points, so the 14 lines make a header and five rows. The columns come out at 66.7, 109.7, 141.2, 251.8 and 333.4. The line under KP-1001 has two segments, "recognised" at 141.2 and "key (kp_test_) in the sandbox, in the" at 333.4; they join the Meaning and advice cells of KP-1001's row.

Run the tests with `pnpm ex test 03.3`.
