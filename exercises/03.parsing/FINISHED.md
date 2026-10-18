---
title: Parsing, done
---

# Parsing, done

Your parser now reads a PDF the way ingestion needs it. A typed page comes from its text layer, exactly and in milliseconds; a page that's only a picture goes through OCR and keeps OCR's confidence. The six pages OCR read worst wait in a queue for a person, and stay searchable meanwhile. A table comes out as markdown rows, with wrapped cells kept in their row and column. And every page keeps its number in the whole document, even when the filing is read in 12 ranges at once.

## What to notice in the lab

Open `/labs/parsing`, signed in as `leo.martin@kestrelpay.example` (password `dev-password`), who can read the contracts and the finance files.

- **The Ashgrove MSA**: pages 1 and 2 say "text layer", with headings and clauses; page 3 says "OCR, 44.8", and its text is the noise you saw in step 1.
- **Page 1 of the error code catalogue**: the KP- codes table as one block, five rows, the advice whole in its cell.
- **The AP batch**: three pages, all OCR, 50.8 to 58.4. In the queue below, accept one page, and correct another by fixing a contract number: the correction cuts that page's chunks again, and the page leaves the queue.
- **The Exec offsite notes** (sign in as `daniel.reyes`, an exec): 88.2, never queued, and "£36m" on the page.

The queue fills when a scanned document is ingested. If it's empty, change one in fake-workspace or run a full sync (`pnpm sync`) and wait for the ingest runs.

## What comes next

Section 04 cuts these blocks into chunks: it relies on headings being headings, tables being whole rows, and pages being the document's. Section 05 runs parsing as a workflow step, and fans the filing out to the 12 page ranges your `readPages` already handles.
