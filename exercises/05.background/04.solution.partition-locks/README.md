---
title: One relay per partition, and outages
type: graded
slots:
  queue/outbox: outbox.ts
---

# One relay per partition, and outages: the solution

`ownPartition` runs `SELECT pg_try_advisory_xact_lock(hashtextextended(<partition key>, 0))` and returns false when it gets false. Then it looks for one pending row of the partition (not published, not failed) whose `(created_at, id)` is below the batch's first row, and returns true only when there's none. `relayOnce` runs `relayBatch` inside `db.transaction`. An `OutageError` thrown inside rolls the transaction back; `relayOnce` catches it outside and returns empty lists with `outage: true`. Any other error goes on up.

## Why it works

- **The lock covers the rows beside the row.** `FOR UPDATE` keeps two relays off one row. The advisory lock is on the partition's name, so while relay 1 delivers version 15, relay 2 can't take version 16, nor any row of that document.
- **It never waits.** The `try` form answers at once, and relay 2 moves on to other partitions. A waiting lock would hold relay 2 until relay 1's whole batch had finished, which is what `SKIP LOCKED` avoided.
- **It ends with the transaction.** The `_xact` form is released at commit or rollback, like the row locks. A session lock belongs to the pooled connection, outlives the pass, and holds the partition for whoever borrows that connection next.
- **The older-row check covers what the lock can't see.** Relay 1 may have locked version 15's row without reaching its partition yet (another partition came first in its batch), so it holds no advisory lock. Relay 2 would then start 16 first. The check sees 15 waiting and leaves the partition alone.
- **And the lock covers what the check can't.** `created_at` is when the writing transaction began. A slow transaction can commit a row older than one relay 1 is already delivering; the check finds nothing older than it, and only the lock stops relay 2.
- **An outage changes nothing.** While the world is down every start fails. Counting each as an attempt would fail every row in reach within ten seconds. Rolling back keeps one simple rule: a pass happens whole or not at all. The starts that went out before the outage are delivered again, and step 3's `claim` makes that safe.

## The worked example

A full sync of Kestrel writes 40 rows. A pass with the world going down at the 8th start: 7 starts went out, then `{ published: [], retried: [], failed: [], skippedPartitions: [], outage: true }`; all 40 rows still waiting, every one at 0 attempts. The next pass publishes 20, the same 7 first.
