---
title: The run state machine
type: graded
slots:
  agent/state: state.ts
---

# The run state machine: the solution

`transition` asks `canTransition` and throws an `IllegalTransitionError(from, to)` when the table doesn't list the move, else returns `to`. `applyStatus` keeps the current status, starting from `from`, and walks the events. It skips anything that isn't a `status` event. For a status event, it throws `IllegalTransitionError(current, event.to)` when the event's `from` isn't the current status, then calls `transition(current, event.to)` and moves there.

## Why it works

- **The status is a fold of the log.** No code sets a run's status directly. Every change is a `status` event, and the status is wherever those events lead from `queued`. So the status column in `runs` and the log can't disagree: `append` (step 2) computes the column from the batch with this function, in the same statement that writes the events.
- **Two checks, two kinds of mistake.** `transition` catches a move that's never allowed (`queued -> succeeded`). The `from` check catches a move that's allowed in general but not now, because the writer read an older run. Both throw before anything is written.
- **The error names the truth.** It reports the status the run is really in, so "a run can't go from cancelled to running" tells the reader at once that someone cancelled it first.
- **Final means no more moves, not no more events.** A result for a call that was already running when the cancel landed is still a fact about the run. Refusing it would leave a mail that went out with no record of it.

## The worked example

Leo's run folds to `waiting` after seq 12 and `succeeded` after seq 17. On `cancel-waiting`, the eleventh event is `waiting -> cancelled`; a `waiting -> running` after it throws "a run can't go from cancelled to running" (`from: "cancelled"`, `to: "running"`), and a `tool_result` after it is recorded with the run still `cancelled`.

This check alone doesn't make concurrent writers safe: two writers could both read `waiting`, and both write a legal move from it. Step 2's version check is what stops the second one. The state machine says which moves exist; the version says whether you're still looking at the run you think you are.
