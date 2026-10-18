---
title: Fan-out over the filing
type: graded
slots:
  queue/fanout: fanout.ts
---

# Fan-out over the filing: the solution

`pageRanges` starts at page 1 and steps by `size`; each range ends at `from + size - 1`, clipped to the last page. `fanOut` walks the ranges `batch` at a time. For each batch it starts every child at once with `Promise.all`, passing each the range's index in the whole list, and waits for all of them. Then it checks the results: a failed one throws, and nothing further starts; otherwise the chunks are added up.

## Why it works

- **Every page is read once.** Inclusive ends that stop one page short of the next range's start leave no gap and no overlap: 3,000 pages, 12 ranges, each page in exactly one.
- **A failure costs one range.** Each child is its own run with its own retries. A range that fails is retried alone, and the others keep their chunks.
- **The load is bounded.** Ten children at a time, whatever the size of the document, so a 40,000-page file can't open 160 database connections at once.
- **Chunks never collide.** A child numbers its chunks from `index × 100,000`. The index is the range's place in the whole list, so ranges sort in page order; the offset within a batch would restart at 0 for range 10, on top of range 0's chunks.
- **It replays the same way.** `fanOut` runs in the workflow body, so it does no I/O of its own and decides the same way every time the run is replayed. Each `child` call creates a hook and starts a run, which Workflow records.

## The worked example

The filing's 3,000 pages make 12 ranges: batch 1 is ranges 0 to 9, batch 2 is ranges 10 and 11. The test ingests it for real: 12 child runs, 5,274 chunks, each range's chunks on its own 250 pages. The CHG-2026-0612 note is chunk 333 of range 9, stored as ordinal 900,333 with `pageStart` and `pageEnd` 2,417, the page your `readPages` numbered in section 03.
