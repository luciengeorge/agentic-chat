---
title: Fan-out over the filing
type: graded
slots:
  queue/fanout: fanout.ts
---

# Fan-out over the filing

👨‍💼 The FCA annual return is 3,000 pages, and compliance asks about facts on any of them. As one step, its ingest is all or nothing: a failure on page 2,900 throws away the work on the pages before it. Kestrel ingests it as 12 child runs of 250 pages instead, ten at a time, each one retried on its own.

## Terms

- **Fan-out** splits one big job into many small ones that run side by side. Here the parent ingest run starts one **child run** per page range, then waits for all of them.
- A **page range** is the pages `from` to `to`, both included (section 03.4 parses one).
- A **batch** is the children started together. The parent starts the next batch only when the one before has finished, so no more than `batch` run at once.
- A **hook** is how a child tells its parent it's done: the parent waits on it, and the child resumes it with its result.

## Do this

🐨 In `playground/fanout.ts`, write `pageRanges`, which cuts a page count into ranges, then `fanOut`, which runs a child for each range, a batch at a time, and stops on the first batch that holds a failure. The ingest workflow calls both for a PDF of more than 500 pages, with ranges of 250 and batches of 10; it creates each child's hook and starts the child for you.

## A worked example

| Range index | Pages          | Batch | Chunk ordinals from |
| ----------- | -------------- | ----- | ------------------- |
| 0           | 1 to 250       | 1     | 0                   |
| 1           | 251 to 500     | 1     | 100,000             |
| ...         |                |       |                     |
| 9           | 2,251 to 2,500 | 1     | 900,000             |
| 10          | 2,501 to 2,750 | 2     | 1,000,000           |
| 11          | 2,751 to 3,000 | 2     | 1,100,000           |

The whole filing makes 5,274 chunks. The note on change CHG-2026-0612 is on page 2,417, in range 9: its chunk is the range's 334th (ordinal 333), so it's stored as 900,333, cited at page 2,417.

Run the tests with `pnpm ex test 05.4`. They need Postgres (`pnpm ex up`).
