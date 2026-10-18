---
title: The outbox and relay
type: graded
slots:
  queue/outbox: outbox.ts
---

# The outbox and relay

👨‍💼 Lena Fischer edits the fraud rules in SharePoint. The sync sees it, writes version 15 of the document, and must start an ingest run for it, or the assistant keeps quoting version 14. Workflow's `start()` is a call to another system: it can't be part of the database transaction that saves the version. Crash between the two, and version 15 is saved but never ingested, and no later sync asks again, because nothing new has changed.

## Terms

- The **outbox** is a table of requests for work (`outbox`). A row is written in the same transaction as the change it stands for, so it exists exactly when the change committed.
- The **relay** reads the outbox and starts a workflow run for each row, then marks the row **published**. It runs on every kick (a request that wrote a row kicks it after commit) and every two seconds.
- A **partition** is a group of rows that must start in order: one document's ingests (`document:<id>`), or one tenant's syncs (`sync:<tenant>`).
- An **advisory lock** is a lock on a number you choose, not on a row. `pg_try_advisory_xact_lock` takes one for the rest of the transaction, or says no if someone holds it.
- **Workflow-first** is the other shape: start the run first, and let its first step write the record (`recordStart`). Use it when nothing else has to commit with the request.

## Do this

🐨 Write `relayOnce` in `playground/outbox.ts`, one pass of the relay: lock a batch of unpublished rows, group them by partition, and deliver each partition's rows oldest first, stopping at the first failure; roll the whole batch back on an outage. The run's side is written: `claim`, which every run's first step calls, and `recordStart` for workflow-first.

## A worked example

A full sync of Kestrel's drive writes 40 documents and, in the same transaction, 40 ingest rows, one partition each. The relay takes 20 rows a pass:

| Pass | Published | Still waiting |
| ---- | --------- | ------------- |
| 1    | 20        | 20            |
| 2    | 20        | 0             |
| 3    | 0         | 0             |

Now say the relay dies after `start()` returned for the Month-End Close Checklist, but before it marked the row published. The row counts one attempt, the next pass delivers it again, and two ingest runs start. One claims the row and ingests; the other finds it claimed and stops as `duplicate`.

Run the tests with `pnpm ex test 05.3`. They need Postgres (`pnpm ex up`).
