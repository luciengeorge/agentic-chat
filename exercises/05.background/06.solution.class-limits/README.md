---
title: Per-class limits
type: graded
slots:
  queue/queue: queue.ts
---

# Per-class limits: the solution

`claimWithinLimits` opens a transaction and first takes the queue's advisory lock, `pg_advisory_xact_lock(hashtextextended('jobs:claim:<queue>', 0))`. It counts the queue's running jobs with a live lease, grouped by class. A class is full when its count has reached its cap (so a cap of 0 is always full, and a class with no cap never is). Then it calls `claim` with the full classes, which `claim` passes over, so the oldest job of a class with room goes first.

## Why it works

- **A slot stays free.** With `backfill` capped at one less than the workers, at least one worker can always take incremental work, however many ranges are queued ahead of it.
- **The count is right because claims take turns.** Counting and claiming are two statements. Without the lock, two workers both count "0 running, cap 1" and both claim. The transaction-scoped lock makes the second wait until the first has committed, so it counts the first's claim. Claims are short, so the wait is milliseconds.
- **A crashed worker's job doesn't hold a slot.** Only jobs whose lease is live count. Once a dead worker's lease runs out, its job stops counting, before `reclaimExpired` has even put it back.
- **Nothing else changes.** Oldest first still holds within the classes that have room, keys still run one at a time, and a worker without `classLimits` claims as before.

## The worked example

Twelve page ranges of the filing, then a webhook's delta, two workers. With no caps, both workers take ranges, and the delta waits behind twelve. With `{ backfill: 1 }`, worker A takes range 1; worker B finds backfill at its cap, finds nothing else due, and gets nothing; the delta arrives, and worker B takes it ahead of eleven older ranges. Eight workers claiming at once with `{ backfill: 3 }` run exactly three ranges.

Why the queue needs this and the relay doesn't: on the queue a job holds its worker from start to finish, and slots are handed out oldest first. The relay only calls `start()`, which returns at once, and Workflow runs a thousand steps at a time locally. There, a backfill costs a delta a few milliseconds of ordering, not a wait.
