---
title: The review queue
type: graded
slots:
  parse/review: review.ts
---

# The review queue

👨‍💼 Grace Adeyemi in accounts payable searches for contract KPC-2025-0177 to check an invoice against it. The invoice is in the AP batch, a scanned PDF, and OCR read the number as "KkPC20250177". Search can't match that, so the invoice never turns up. Kestrel wants a person to look at the pages OCR struggled with before someone needs them.

## Terms

- A **confidence** is OCR's score, 0 to 100, for how sure it is of each word. A page's `ocrConfidence` is the mean over its words.
- The **threshold** (`DEFAULT_OCR_REVIEW_THRESHOLD`, 70) is the lowest confidence that's good enough. A page under it goes to review.
- The **review queue** is the `ocr_reviews` table: one row per page waiting for a person, who **accepts** it (OCR read it right) or **corrects** it (types what it says).
- A **retry** is Workflow running a failed step again. A step can fail after its work committed, so its retry may do the same work twice.

## Do this

🐨 In `playground/review.ts`, write `pagesToReview`, which picks the OCR'd pages under the threshold, then `queueOcrReviews`, which writes a row for each of them in the caller's transaction and does nothing for a page already queued. The ingest step already calls `queueOcrReviews` right after it writes the chunks. Accepting, correcting and listing are written for you.

## A worked example

What tesseract reads on the corpus's 12 scanned pages, by confidence:

| Pages                                    | Confidence   | At 70      |
| ---------------------------------------- | ------------ | ---------- |
| The MSA's signature page                 | 44.8         | queued     |
| The AP batch, pages 2, 3 and 1           | 50.8 to 58.4 | queued     |
| The Marlow and Finch order form, 1 and 2 | 59.8, 66.6   | queued     |
| The handwriting (three notes, six pages) | 83.3 to 90.4 | not queued |

So 70 queues six pages and none of the handwriting. But a high mean isn't a clean page: the Exec offsite notes read at 88.2, and OCR turned "Price stays at £86m" into "£36m".

Run the tests with `pnpm ex test 03.2`. They need Postgres (`pnpm ex up`).
