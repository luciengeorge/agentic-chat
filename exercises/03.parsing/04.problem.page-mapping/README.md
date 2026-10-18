---
title: Page mapping
type: graded
slots:
  parse/pdf: pdf.ts
---

# Page mapping

👨‍💼 Kestrel's compliance team asks "how many authorisations went through the backup connection during change CHG-2026-0612?" The answer, 2,690, is a note on page 2,417 of the FCA annual return, a 3,000-page filing. The assistant should cite page 2,417, and the citation should open the filing there. Ingestion parses the filing in ranges of 250 pages, side by side, and each range has to keep the filing's own page numbers.

## Terms

- A **page range** is the pages `from` to `to`, both included, counted from 1.
- **Page mapping** is keeping, for every block and every chunk, the page of the whole document it came from. The chunker sets each chunk's `pageStart` and `pageEnd` from it.
- A **fan-out** splits one big job into many small ones that run side by side: here, one child run per page range (section 05 builds it).

## Do this

🐨 Write `readPages` in `playground/pdf.ts`: work out the first and last page, refuse a range that's outside the document, and read each page in between with `readPage` (your step 1 code), numbered as it is in the whole document. `parsePdf` opens the PDF, calls `readPages` and closes it again.

## A worked example

The filing is 3,000 pages, cut into 12 ranges of 250. The tenth range is pages 2,251 to 2,500:

| Page of the range | Page of the filing | What's on it                                    |
| ----------------- | ------------------ | ----------------------------------------------- |
| 1st               | 2,251              |                                                 |
| 167th             | 2,417              | the note on CHG-2026-0612: 2,690 authorisations |
| 250th             | 2,500              |                                                 |

The chunk holding that note must say page 2,417 for both `pageStart` and `pageEnd`. Page 167 of the filing is a safeguarding reconciliation for 9 January.

Run the tests with `pnpm ex test 03.4`.
