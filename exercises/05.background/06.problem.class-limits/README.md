---
title: Per-class limits
type: graded
slots:
  queue/queue: queue.ts
---

# Per-class limits

👨‍💼 Monday morning, a full sync of Kestrel's drive queues the filing's twelve page ranges. A minute later Maya Levi fixes a typo in the Ashgrove MSA, and the webhook queues a delta sync to pick it up. Both workers are busy with page ranges, and the queue hands out jobs oldest first, so Maya's change waits for all twelve. She searches for her fix, and it isn't there.

## Terms

- A job's **class** says what kind of work it is: `backfill` for a full sync's bulk work, `incremental` for a small delta. `enqueue(..., { class })` sets it.
- A **cap** is the most jobs of one class that may run at once. `ClassLimits` maps a class to its cap, say `{ backfill: 1 }`; a class it doesn't name has no cap.
- **Starvation** is work that never gets a turn because other work holds every worker.
- An **advisory lock** is a lock on a number you choose. `pg_advisory_xact_lock` waits for it and keeps it until the transaction ends.

## Do this

🐨 Write `claimWithinLimits` in `playground/queue.ts` (your step 1 file, with one change: `claim` now takes the classes to pass over). Under the queue's claim lock, count what's running by class, work out which classes are at their cap, and claim past them. The worker loop already calls it when it's given `classLimits`.

## A worked example

Two workers, twelve backfill ranges queued first, then one delta:

|                   | Worker A | Worker B  | The delta    |
| ----------------- | -------- | --------- | ------------ |
| No caps           | range 1  | range 2   | waits for 12 |
| `{ backfill: 1 }` | range 1  | the delta | runs now     |

With no caps, the delta starts only once twelve ranges have been claimed ahead of it: six rounds of two. With backfill capped at one less than the workers, worker B passes over eleven older ranges and takes the delta. Once both are done, worker B takes range 2.

Run the tests with `pnpm ex test 05.6`. They need Postgres (`pnpm ex up`). The lab, `/labs/background`, runs this same race on a queue board.
