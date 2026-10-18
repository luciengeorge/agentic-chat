---
title: A job queue by hand
type: graded
slots:
  queue/queue: queue.ts
---

# A job queue by hand: the solution

`claim` is one statement. A `WITH` part picks the job: on this queue, `queued`, due, key free, ordered by `run_at` then `created_at`, `LIMIT 1`, `FOR UPDATE SKIP LOCKED`. The `UPDATE` then takes that row: `running`, `attempts + 1`, `locked_by` the worker, `locked_until` now plus the lease. `RETURNING` hands the row back.

## Why it works

- **No job goes to two workers.** `FOR UPDATE` locks the row it picks until the transaction ends, so a second worker can't pick it too.
- **No worker waits on another.** `SKIP LOCKED` passes over the locked row to the next one. Without it, the second worker would wait until the first worker's transaction ends before it could look further, so claims would go one at a time, and one slow claim would hold up every worker.
- **The attempt counts when the job is taken.** A worker that dies never reports its failure, so counting on claim is the only count that's always right. `fail` reads it: under `max_attempts` the job waits its backoff, at `max_attempts` it goes `dead`.
- **A crash gives the job back.** Nobody renews a dead worker's lease. Once `locked_until` passes, `reclaimExpired` sets the job `queued` again, and a late `complete` from the old worker changes nothing, because the row's `locked_by` is no longer its own.

## The worked example

16 workers claiming at once over 10 jobs get 10 different jobs, and 6 get none. A poison job is claimed five times; after attempts 1 to 4, `fail` sets its next run 1, 2, 4 and 8 seconds out (the worker's backoff, from the attempt count), and after attempt 5 it's `dead`: 15 seconds of waiting in all. A job claimed with a 150 ms lease and never renewed is back on the queue after 250 ms, and its next claim is attempt 2.

This is the same pattern as Sidekiq's or Cloud Tasks' delivery, built on the database you already have: at-least-once (a crash means a second run), so the work itself must be safe to repeat. Section 15 builds on it.
