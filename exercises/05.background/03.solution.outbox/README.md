---
title: The outbox and relay
type: graded
slots:
  queue/outbox: outbox.ts
---

# The outbox and relay: the solution

`relayOnce` opens one transaction and runs `relayBatch` in it. `relayBatch` selects the oldest `batchSize` rows that are neither published nor failed, `FOR UPDATE SKIP LOCKED`, and groups them by partition in a `Map`, which keeps their order. For each partition it hands the rows to `deliverRow` one at a time, and stops that partition at the first row that didn't go out; the next partition carries on.

## Why it works

- **No change without its request, and no request without its change.** The row commits with the version, in one transaction, so either both exist or neither does. The relay only ever sees committed rows.
- **At least once, made safe.** A row is marked published after `start()` returns. If the relay dies in between, the next pass starts the run again. Every run's first step claims its row by id; the second run finds it claimed and stops. The relay can repeat itself; the run can't.
- **In order within a partition.** Stopping at the first failure keeps a document's later ingest from starting before an earlier one. Other partitions don't wait for it.
- **Two relays never take the same row.** `FOR UPDATE` locks the batch until the transaction ends, and `SKIP LOCKED` sends a second relay (the kicked one beside the two-second poll, or another server) past those rows to the next ones, without waiting.
- **Two gaps left for step 4.** That second relay can still take a later row of a partition the first holds, and start version 2 while version 1 is still going out. And an outage, where every start fails, counts an attempt on every row it touches.

## The worked example

After a full sync of Kestrel, the outbox holds 40 ingest rows. Three passes publish 20, 20 and 0, every row once, oldest first. A delivery that fails after its `start()` leaves the Month-End Close Checklist's row unpublished with one attempt; the next pass delivers it again; of the two runs, one ends `ready` and one `duplicate`.

**Outbox or workflow-first?** `INGEST_START=workflow-first` makes the sync start its ingest runs itself, in a step after the drive step, and each run writes its own record with `recordStart` (a uuid made from `ingest:<document>:<version>`, so a second start finds it). That's safe here only because the list of runs to start is a step's saved output, so a crash mid-start retries with the same list. Use the outbox when the request must commit with other data (a sync's documents, a webhook receipt and its dedupe key); use workflow-first when the workflow owns the work from the start. `src/workflows/ingest-start.ts` has the details.
