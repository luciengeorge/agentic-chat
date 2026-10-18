---
title: The review queue
type: graded
slots:
  parse/review: review.ts
---

# The review queue: the solution

`pagesToReview` keeps the pages whose `method` is `"ocr"` and whose confidence is under the threshold. `queueOcrReviews` takes those pages and inserts one `ocr_reviews` row each, on the transaction it was given, with `onConflictDoNothing()`. `returning` gives back only the rows it really added, so the count is right on a retry too.

## Why it works

- **Typed pages are never queued.** A text-layer page has no confidence, because nothing was guessed. Reading the missing value as 0 would queue every typed page in the corpus; checking the method first queues none.
- **The rows commit with the chunks.** The ingest step writes a version's chunks and its reviews in one transaction. A failure rolls both back, so the queue never points at chunks that aren't there.
- **A retry changes nothing.** The table's unique key is (document, version, page). On a second run each insert meets its own row and does nothing, so the reviewer's work on it survives, and the step still succeeds.
- **The page stays searchable meanwhile.** Queueing only adds a row. The chunks OCR made are already written, so a misread scan is findable by its other words today, and a correction later swaps its chunks in place.

## The worked example

At 70, the six pages queued are the AP batch's three (58.4, 50.8, 51.1), the order form's two (59.8, 66.6) and the MSA's signature page (44.8). The six handwritten pages read from 83.3 to 90.4 and aren't queued. Run the AP batch twice and the second run queues 0.

The cost of a mean shows on the offsite notes: page 1 reads at 88.2, and OCR turned "£86m" into "£36m" and "Q4" into "®4". A few misread words on a page of good ones barely move the mean. Catching those needs the per-word confidences, which this queue doesn't use: it finds bad pages, not bad words.
