---
title: The run state machine
type: graded
slots:
  agent/state: state.ts
---

# The run state machine

👨‍💼 Leo's email run is waiting for his approval. He changes his mind and cancels it from the inbox. A second later, a tab he left open sends the approval, and the runner tries to resume the run. If the second write wins, a cancelled run starts running again and the mail goes out. The run's status has to be something no stale writer can move by mistake.

## Terms

- A **status move** is a `status` event in the log: `{ type: "status", from, to, reason? }`. The run's status is where its status events leave it, starting from `queued`.
- **`TRANSITIONS`** lists the moves a status may make. `queued` may go to `running` or `cancelled`; `running` to `waiting` or any of the four final statuses; `waiting` back to `running`, or to `cancelled` or `timed_out`. A **final** status (`succeeded`, `failed`, `cancelled`, `timed_out`) goes nowhere.
- A **stale writer** is code that decided what to write from a run it read earlier, before someone else changed it.

## Do this

🐨 In `playground/state.ts`, write `transition`, which checks one move, and `applyStatus`, which folds a batch of events onto a status. The table, `isFinal` and `statusOf` are written. Every append to the log (step 2) runs its batch through `applyStatus` first, so a batch it refuses never reaches the database.

🚨 The classic mistake is checking only the move the event describes. `waiting -> running` is a legal move, so a check of the event alone lets it through after a cancel. The event's `from` has to be the status the run is in now.

## A worked example

Leo's recorded email run has 17 events. Four are status moves: `queued -> running` at seq 2, `running -> waiting` at seq 12 (the approval), `waiting -> running` at 14 (he approved), and `running -> succeeded` at 17. Fold the first 12 and the run is `waiting`; fold all 17 and it's `succeeded`.

Tom's smoke run `cancel-waiting` went the other way: waiting at seq 9, then `waiting -> cancelled` at seq 11, "cancelled by the user". Append a stale `waiting -> running` after it and `applyStatus` must throw "a run can't go from cancelled to running". Append the tool result of a call that was in flight, and the run stays `cancelled`, with the result recorded.

Run the tests with `pnpm ex test 14.1`.
