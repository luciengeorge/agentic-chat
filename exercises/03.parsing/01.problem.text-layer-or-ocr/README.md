---
title: Text layer or OCR
type: graded
slots:
  parse/pdf: pdf.ts
---

# Text layer or OCR

👨‍💼 Kestrel's legal team asks "who signed the Ashgrove contract for us?" The answer is on the last page of the MSA, KPC-2026-0142. Its first two pages were typed and saved as a PDF, so their words are in the file. The last page was printed, signed by hand and scanned back in: in the file it's a picture, with no words at all. Read only the stored words, and the signature page comes out empty.

## Terms

- The **text layer** of a PDF page is the text it draws, as a list of runs, each with a position and a font size. pdf.js hands it back as `items`.
- A **visible character** is one that isn't a space, a tab or a newline.
- **OCR** reads the letters off a picture of the page. `scan()` draws the page as a picture and OCRs it: it gives back the text and a **confidence**, OCR's own score from 0 to 100 for how sure it is.
- `MIN_TEXT_LAYER_CHARS` (20) is how many visible characters a page needs before its text layer is trusted.

## Do this

🐨 Write `readPage` in `playground/pdf.ts`. Count the page's visible characters. With at least 20, lay the text layer out as blocks with `layoutPage`. With fewer, the page is a picture: call `scan()`, turn its text into blocks with `ocrBlocks`, and keep the confidence. `parsePdf` already calls `readPage` for every page.

## A worked example

The Ashgrove MSA, page by page:

| Page | Visible characters | Read from  | Confidence |
| ---- | ------------------ | ---------- | ---------- |
| 1    | 2,102              | text layer |            |
| 2    | 2,202              | text layer |            |
| 3    | 0                  | OCR        | 44.8       |

The rest of the corpus agrees. Of its 93 PDF pages (leaving out the 3,000-page filing), 12 have no visible characters: the scans and the handwriting. The emptiest of the others, page 2 of the price list, has 33, all in its footer: a blank page. A cut at 20 falls between the two.

Run the tests with `pnpm ex test 03.1`.
