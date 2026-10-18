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
- The **relay** reads the outbox and starts a workflow run for each row, then marks the row **published**. It runs every two seconds, and also whenever it's kicked.
- A **kick** is a signal inside the server process (`kickRelay()`, an event) that wakes the relay at once instead of at its next two-second poll. Code that wrote an outbox row (the webhook, the sync's drive step) sends one after its transaction commits, so the run starts within milliseconds. A lost kick costs nothing: the poll finds the row anyway.
- A **partition** is a group of rows that must start in order: one document's ingests (`document:<id>`), or one tenant's syncs (`sync:<tenant>`).
- **Workflow-first** is the other shape: start the run first, and let its first step write the record (`recordStart`). Use it when nothing else has to commit with the request.

## Do this

🐨 Write `relayBatch` in `playground/outbox.ts`, the body of one pass of the relay: lock a batch of unpublished rows, group them by partition, and deliver each partition's rows oldest first, stopping that partition at its first failure. `relayOnce` runs it in one transaction. The run's side is written: `claim`, which every run's first step calls, and `recordStart` for workflow-first. Step 4 then makes two relays and an outage safe.

## A worked example

A full sync of Kestrel's drive writes 40 documents and, in the same transaction, 40 ingest rows, one partition each. The relay takes 20 rows a pass:

| Pass | Published | Still waiting |
| ---- | --------- | ------------- |
| 1    | 20        | 20            |
| 2    | 20        | 0             |
| 3    | 0         | 0             |

Now say the relay dies after `start()` returned for the Month-End Close Checklist, but before it marked the row published. The row counts one attempt, the next pass delivers it again, and two ingest runs start. One claims the row and ingests; the other finds it claimed and stops as `duplicate`.

Run the tests with `pnpm ex test 05.3`. They need Postgres (`pnpm ex up`).
