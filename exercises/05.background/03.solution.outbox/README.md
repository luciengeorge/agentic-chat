---
title: The outbox and relay
type: graded
slots:
  queue/outbox: outbox.ts
---

# The outbox and relay: the solution

`relayOnce` opens one transaction. It selects the oldest `batchSize` rows that are neither published nor failed, `FOR UPDATE SKIP LOCKED`, and groups them by partition in a `Map`, which keeps their order. For each partition it asks `ownPartition`; a partition it can't own goes in `skippedPartitions`. Otherwise it hands the rows to `deliverRow` one at a time, and stops at the first that didn't go out. An `OutageError` escapes the transaction, which rolls the batch back; outside, `relayOnce` catches it and reports `outage: true`.

## Why it works

- **No change without its request, and no request without its change.** The row commits with the version, in one transaction, so either both exist or neither does. The relay only ever sees committed rows.
- **At least once, made safe.** A row is marked published after `start()` returns. If the relay dies in between, the next pass starts the run again. Every run's first step claims its row by id; the second run finds it claimed and stops. The relay can repeat itself; the run can't.
- **In order within a partition.** Stopping at the first failure keeps a document's later ingest from starting before an earlier one. Other partitions don't wait for it.
- **One owner per partition.** Two relays lock different rows with `SKIP LOCKED`, so both could hold part of one partition. The advisory lock (and the check for an older row locked elsewhere) gives each partition to one relay at a time.
- **An outage costs nothing.** If the world can't be reached, every start would fail and burn through every row's five attempts. Rolling back leaves them as they were.

## The worked example

After a full sync of Kestrel, the outbox holds 40 ingest rows. Three passes publish 20, 20 and 0, every row once, oldest first. A delivery that fails after its `start()` leaves the Month-End Close Checklist's row unpublished with one attempt; the next pass delivers it again; of the two runs, one ends `ready` and one `duplicate`.

**Outbox or workflow-first?** `INGEST_START=workflow-first` makes the sync start its ingest runs itself, in a step after the drive step, and each run writes its own record with `recordStart` (a uuid made from `ingest:<document>:<version>`, so a second start finds it). That's safe here only because the list of runs to start is a step's saved output, so a crash mid-start retries with the same list. Use the outbox when the request must commit with other data (a sync's documents, a webhook receipt and its dedupe key); use workflow-first when the workflow owns the work from the start. `src/workflows/ingest-start.ts` has the details.
