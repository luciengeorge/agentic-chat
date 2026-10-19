---
title: The event log
type: graded
slots:
  agent/events: events.ts
---

# The event log

👨‍💼 Leo's email run is waiting on his approval. He clicks Approve in the inbox and, in the same second, types "Copy Amara Okafor too." in the chat. Two requests, two transactions, both writing to the same run's log. Neither may lose the other's event, both can't take seq 13, and whichever goes second decided what to write from a run that has since moved on. It must find that out, not write over it.

## Terms

- An **append** writes one batch of events to a run's log in one go: say, an approval request and the move to `waiting`. Each append bumps the run's `version` by one, whatever the batch's size.
- The **expected version** is the version the writer read before it decided what to write. The append only happens if the run is still at it.
- A **version conflict** (`VersionConflictError`) is what a writer gets when the run moved on since it read it. The writer reads the run again and decides again.
- A **row lock** is held by a transaction that updated a row, until it ends. Another transaction updating the same row waits for it.
- A **CTE** (common table expression) is a named subquery at the top of a statement: `WITH name AS (...)`. A **data-modifying** one can be an `UPDATE ... RETURNING`, whose rows the rest of the statement reads.

## Do this

🐨 In `playground/events.ts`, write `append`. It checks the version, runs the batch through your state machine from step 1, then bumps the run and inserts the events in a single SQL statement. `readEvents`, `toRunEvent` and the errors are written.

🚨 The classic mistake is reading `max(seq)` in one statement and inserting in another, or checking the version only in JavaScript. Both pass when writers take turns and break when two arrive together: the second one gets a duplicate-key error, or both land. The tests hold one writer's transaction open while another waits, so a race happens every time.

## A worked example

Leo's recorded run has 17 events and version 15: seq 6 and 7 (two tool results from one turn) were one append, and seq 11 and 12 (the approval request and `running -> waiting`) another. Replay its 15 appends into an empty run and you must get seq 1 to 17 at version 15, `succeeded`.

Then load it as it stood at seq 12: version 10, `waiting`. The approval appends at version 10 and holds its transaction open. The follow-up, also at version 10, waits on the run's row lock. Let the approval commit: it's seq 13, at version 11. The follow-up's update finds version 11 and changes nothing, so it inserts nothing and throws a `VersionConflictError`. A writer that read version 10 and arrives after the commit is told "run 52a826fa-5e51-45b7-812a-873be72226c1 is at version 11, not 10".

Run the tests with `pnpm ex test 14.2`. They need Postgres (`pnpm ex up`).
