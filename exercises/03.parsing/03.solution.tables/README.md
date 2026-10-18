---
title: Tables to markdown
type: graded
slots:
  parse/layout: layout.ts
---

# Tables to markdown: the solution

`tableRows` sorts every segment of every line by `x0` and sweeps left to right. A segment that starts inside the current column (at most a point past its right edge) widens it; any other starts a new one. Then it walks the lines: a gap of more than 1.4 font sizes above a line starts a row, a smaller one continues the row before. Each segment goes to the column whose range holds its start, and each cell's pieces are joined with spaces.

## Why it works

- **Columns come from the white space, not from one line.** A wrapped line holds only the cells that wrapped, so "the second segment" means a different column on every line. The gutters are empty on every line of the table, so the x ranges between them are the columns, whatever any one line holds.
- **A range catches right-aligned numbers.** Amounts aligned on their right edge start at different x positions. Matching starts would scatter them; a column reaching from its leftmost start to its rightmost end holds them all.
- **Rows come from the gap above.** The renderer puts a wrapped line one line height down and leaves more room before a new row. 1.4 font sizes sits between the two, so a cell's lines stay together.
- **An empty cell stays empty.** Every row starts with one empty list per column, so a missing cell is `""` and the cells after it keep their places.

## The worked example

On page 1 of the error code catalogue, the 14 lines make five columns, starting at 66.7, 109.7, 141.2, 251.8 and 333.4. Eight lines sit 11.2 to 11.3 points under the line above, inside the cut of 12.6, so they're wrapped lines. Five sit 15.8 to 16.3 down and start rows. The result is the header and five rows, KP-1001 to KP-1009, and KP-1009's row reads `| KP-1009 | 429 | Rate limit exceeded | Yes, after Retry-After | Back off and retry. ... |`: one row, so one chunk holds the code and its advice together.
