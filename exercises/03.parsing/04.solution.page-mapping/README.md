---
title: Page mapping
type: graded
slots:
  parse/pdf: pdf.ts
---

# Page mapping: the solution

`readPages` takes `from` and `to` from the range (1 and `numPages` without one) and checks them: whole numbers, `from` at least 1, `to` at most the page count, and `from` no later than `to`. Otherwise it throws a `RangeError` that names both. Then it loops from `from` to `to`, both included. For each number it opens that page, reads it with `readPage` under that same number, with a scan that draws that same page, and releases it.

## Why it works

- **The number is the document's.** The loop variable is the page's number in the whole file, and it's what goes into the page, the scan and pdf.js's `getPage`. Nothing counts from the start of the range, so a range of the filing reads exactly as the whole filing would.
- **Both ends are read.** `number <= to` includes the last page. Across the filing's 12 ranges, `<` would skip pages 250, 500 and so on up to 3,000.
- **A bad range stops early, with a clear message.** pdf.js has no page 0 and no page 3,001. Checking first gives "page range 7-8 is outside 1-7", and ingestion treats it as bad input that a retry can't fix.
- **Memory stays flat.** Each page is released as soon as it's read, so a range of 250 pages costs about what one page does.

## The worked example

Pages 2,251 to 2,500 of the filing read as 250 pages numbered 2,251 to 2,500 (in about a third of a second). The note on CHG-2026-0612 is the range's 167th page, page 2,417, and the chunk holding it says `pageStart` 2,417 and `pageEnd` 2,417. When section 05 runs the filing as 12 child runs, each one writes chunks with these numbers, and a citation for 2,690 authorisations opens the filing at page 2,417.
