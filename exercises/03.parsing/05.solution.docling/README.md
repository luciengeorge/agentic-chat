---
title: docling compared
type: guided
---

# docling compared: what the run shows

From one run of `scripts/parse-compare.ts` (docling-serve 1.35.0 on a laptop, CPU only):

| Document                    | Ours  | docling | What differs                                                                   |
| --------------------------- | ----- | ------- | ------------------------------------------------------------------------------ |
| Q3 report (typed, tables)   | 0.1 s | 35.3 s  | Nothing in the text or tables. docling also calls table captions headings      |
| Contract register (typed)   | 0.0 s | 25.2 s  | docling glues "KPC-2026-0298restricted" on page 5, losing the number           |
| Ashgrove MSA (typed + scan) | 2.7 s | 6.1 s   | Page 3: docling finds a 15 by 2 table and reads "Priya Nair"; we don't         |
| AP batch (scans)            | 7.8 s | 14.1 s  | docling finds six tables and reads LOI-2026-0342, KPC-2025-0177, KPC-2025-0181 |
| HR case note (handwriting)  | 3.1 s | 4.1 s   | 98% of words shared. docling reads "11:15" where we read "11:1S"               |
| Brightwell pack (Word)      | 0.1 s | 1.0 s   | Identical: the same four tables                                                |

## What it means

- **On typed PDFs, ours is as good and hundreds of times faster.** Every word and every table shape of the Q3 report and the register matches. The text layer is exact; there's nothing for a model to improve. docling spends 25 to 35 seconds a document running its layout model anyway.
- **docling can lose an identifier.** On the register's last page it joined the contract number to the next cell's word. That's the M0 lesson again (every identifier whole in some chunk), and our parser passes it here because it keeps cells apart by their gutters.
- **On scans, docling is far better.** OCR alone gives us lines of text with misread characters and no structure. docling's layout model finds the invoice tables on the AP batch and the signature table on the MSA, and reads the numbers we lost (our OCR wrote "KkPC20250177"). These are the pages step 2 queues for a person.
- **On handwriting, they're even.** Both run OCR over the same strokes.

So a production design could keep our parser for text-layer pages and send only the OCR pages (12 of 93 in this corpus) to docling: its accuracy where it matters, at a few seconds a scan instead of half a minute a document.

💯 Try it: in `readPage`, send a page that has no text layer to docling instead of `scan()` (docling-serve can convert a page range of a file), and compare what the review queue's six pages read afterwards.
