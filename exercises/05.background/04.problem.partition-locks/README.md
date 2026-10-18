---
title: One relay per partition, and outages
type: graded
slots:
  queue/outbox: outbox.ts
---

# One relay per partition, and outages

👨‍💼 Lena Fischer saves the fraud rules twice in a minute, so the outbox holds version 15's ingest row and then version 16's, in one partition. The kicked relay locks version 15's row and starts its run. The two-second relay runs meanwhile, passes over the locked row, takes version 16's and starts it too, perhaps first. This app's ingest happens to notice (a run for an old version stops as `superseded`), but the outbox promises order within a partition for every kind of row, so the relay keeps it itself. And when Workflow can't be reached at all, the relay must wait it out without failing good rows.

## Terms

- An **advisory lock** is a lock on a number you choose, not on a row, so it can stand for a whole partition. `pg_try_advisory_xact_lock` takes one for the rest of the transaction, or answers false at once if someone else holds it.
- An **outage** is the workflow world being unreachable, so every `start()` fails. `deliver` throws an `OutageError` for it, and `deliverRow` lets that through without counting an attempt.
- To **roll back** a transaction is to undo everything it wrote, as if it never ran.

## Do this

🐨 Write two functions in `playground/outbox.ts` (your step 3 file, with `relayBatch` now asking `ownPartition` before each partition). `ownPartition` says whether this relay may deliver a partition: it holds the partition's advisory lock, and no older row of it waits elsewhere. `relayOnce` runs `relayBatch` in one transaction and turns an outage into a rollback and `outage: true`.

## A worked example

A full sync of Kestrel's drive writes 40 ingest rows. The relay takes 20, and Workflow goes down after 7 starts: the 8th throws an `OutageError`.

|                               | Rows waiting | Attempts counted | Published |
| ----------------------------- | ------------ | ---------------- | --------- |
| Before the pass               | 40           | 0                | 0         |
| After the outage, rolled back | 40           | 0                | 0         |
| Counted as plain failures     | 33           | 13 failed tries  | 7         |

Counted as plain failures, every pass while the world is down costs each row it reaches an attempt, and five passes (ten seconds of polling) fail those good rows for good. Rolled back, the outbox is as it was. When the world comes back, the next pass takes 20 again, and the 7 that went out before the outage go out a second time; their second runs find the rows claimed and stop as `duplicate`, as in step 3.

Run the tests with `pnpm ex test 05.4`. They need Postgres (`pnpm ex up`).
