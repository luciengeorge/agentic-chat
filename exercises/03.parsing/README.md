---
title: Parsing
---

# Parsing

Before Kestrel's assistant can search a document, ingestion has to turn the file into text it can cut up: which words are on which page, which lines are headings, which are table rows. That's **parsing**. Everything after it (chunks, embeddings, search, citations) can only be as good as what the parser read.

Kestrel's files are messy in the usual ways. Most PDFs carry their words as text, but some pages are scans: a picture of paper, with no text at all. A table comes out of a PDF as loose pieces of text at positions. And a citation has to open the page a fact came from, even in a 3,000-page filing.

## Terms

- A **PDF** stores each page as drawing instructions. The **text layer** is the part that draws characters: each run of text with its position and font size. A program can read it back exactly.
- A **scan** is a page that's only a picture. Its text layer is empty.
- **OCR** (optical character recognition) reads the letters off a picture of a page. Ours is tesseract.js. It's slower than reading the text layer, and it gets some characters wrong.
- **Rasterising** a page draws it as a picture (a PNG), which is what OCR reads.
- A **confidence** is OCR's own score, 0 to 100, for how sure it is of a word. A page's confidence is the mean over its words.
- A **block** is one piece of a parsed page: a heading, a paragraph, or a table written as markdown.

## The steps

Each step works on one file in `src/core/parse/`, which the app imports as `#learn/parse/<file>`.

1. **Text layer or OCR** (`pdf.ts`). Decide, page by page, whether to read the text layer or OCR the page.
2. **The review queue** (`review.ts`). Send the pages OCR was least sure of to a person.
3. **Tables to markdown** (`layout.ts`). Rebuild a table's rows and columns from loose positioned text.
4. **Page mapping** (`pdf.ts`). Parse a range of pages, keeping each page's number in the whole document.
5. **docling compared** (guided). Run a production parser over the same files and see where ours falls short.

The lab, `/labs/parsing`, shows a parsed page as your code reads it (its blocks, how it was read, OCR's confidence) and the review queue. Leave it open while you work.
