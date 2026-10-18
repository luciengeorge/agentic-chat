---
title: Text layer or OCR
type: graded
slots:
  parse/pdf: pdf.ts
---

# Text layer or OCR: the solution

`readPage` adds up the visible characters of every run on the page: each `str` with its spaces, tabs and newlines taken out. At 20 or more, the page is laid out from its text layer, and `scan()` is never called. Below 20, the page is treated as a picture: `scan()` draws it and OCRs it, `ocrBlocks` cuts the text into paragraphs, and the page keeps OCR's confidence.

## Why it works

- **It counts what a reader would see.** A text layer can hold runs of nothing but spaces, or a page number a scanner stamped on. Counting items, or the raw length of each `str`, would call such a page typed and never read its body.
- **It decides page by page.** One file can mix both kinds, as the MSA does. A decision per file either loses the signed page or sends typed pages through OCR, which is slower, misreads characters and gives plain paragraphs with no headings or tables.
- **It only pays for OCR when it must.** Drawing and reading a page takes seconds (the AP batch's three pages took 8.7 s); the text layer takes milliseconds. `scan()` runs only on the picture path.
- **It keeps the confidence.** The next step uses it to send the pages OCR was least sure of to a person.

## The worked example

The MSA's pages 1 and 2 have 2,102 and 2,202 visible characters and read from the text layer. Page 3 has none, so it's drawn and OCR'd, and tesseract reads it at 44.8. It finds "KPC-2026-0142" and the stamp "RECEIVED BY KESTREL LEGAL 19 MAR 2026", but the signatures come out as noise ("Chief Financia Ofer"). Across the corpus, exactly the 12 pages with an empty text layer go through OCR. Page 2 of the price list, with 33 visible characters, reads from its text layer and gives no blocks at all: its only text is the footer, which layout drops.

Why 20 and not 1: a cut anywhere from 1 to 33 splits this corpus, and 20 still sends a scan with a stamped "Page 3 of 3" (8 characters) to OCR.
