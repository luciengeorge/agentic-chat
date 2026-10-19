---
title: The event log
type: graded
slots:
  agent/events: events.ts
---

# The event log: the solution

`append` reads the run's status and version, throws `RunNotFoundError` or `VersionConflictError` (with the version it found), and folds the batch with `applyStatus`. Then one statement does the rest. A `bumped` CTE updates the run `WHERE id = $run AND version = $expected AND status = $read`, setting the new version, status, `active_ms`, `updated_at` and, for a final status, `finished_at`, and returns the row. A `last` CTE reads `coalesce(max(seq), 0)` from the log. The `INSERT` takes its rows from `bumped`, `last` and the batch unpacked with `jsonb_array_elements ... WITH ORDINALITY`, so event i gets seq `last + i` and step key `<stepKey>:<i-1>`. If no row comes back, the update changed nothing, and that's a `VersionConflictError` with no known version.

## Why it works

- **The version is decided under the row lock.** Two writers can both read version 10. The first `UPDATE` locks the run's row and moves it to 11. The second blocks on the lock; when the first commits, Postgres re-checks the second's `WHERE` against the row as it now is (that's how `READ COMMITTED` treats an update that waited). Version 11 doesn't match 10, so it updates nothing.
- **No update, no insert.** The events come from a join with `bumped`. When `bumped` is empty, the join is empty, so a writer that lost never numbers or inserts anything. Its error is a clean conflict, not a duplicate key.
- **Seq and version can't drift apart.** Both change in one statement, so either both happen or neither does, even if the caller didn't open a transaction. The log's `seq` counts events and the run's `version` counts appends: 17 and 15 for Leo's run.
- **The loser is told, never retried for.** `append` doesn't retry. The writer chose its events from the run it read (a model turn that didn't see the follow-up, a status move from the old status), so only it can decide whether they still make sense. Step 5's `appendRetrying` is that decision for the events that stay true whatever happened.
- **Why optimistic.** A runner thinks for seconds (a model turn) before it writes. Locking the run that long would hold up the cancel button, the inbox and every follow-up. With a version, nobody waits while anyone thinks, and a race costs the loser one more read.

## The worked example

Replaying Leo's 15 appends into an empty run gives seq 1 to 17 at version 15, `succeeded`, with the data read back exactly as recorded. Loaded at seq 12 (version 10, `waiting`), the approval wins seq 13 and version 11 while the follow-up waits on the row lock; the follow-up then throws a `VersionConflictError` and the log stops at 13. A writer still holding version 10 after that is told "run 52a826fa-5e51-45b7-812a-873be72226c1 is at version 11, not 10". Of eight writers at one version, one lands and seven conflict, and the log grows by exactly one event.
