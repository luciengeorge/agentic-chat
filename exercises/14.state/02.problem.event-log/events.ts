// 👨‍💼 Every part of a run writes to its log: the runner (model turns, tool results), the approval route, the
//    cancel button, a follow-up message. They run in different requests, often at the same moment, and none of
//    them holds a lock while it thinks. The log must still come out with each event once, in one order, with no
//    gaps, and a writer that decided from an old view of the run must be told so instead of writing over it.

import { sql } from "drizzle-orm";

import type { RunEvent, RunEventData, RunStatus } from "#learn/agent/types";
import type { Tx } from "@/db/tenant";

/** Someone appended since the caller read the run: re-read, decide again, retry. */
export class VersionConflictError extends Error {
  override name = "VersionConflictError";
  constructor(
    readonly runId: string,
    readonly expected: number,
    readonly actual: number | null,
  ) {
    super(`run ${runId} is at version ${actual ?? "?"}, not ${expected}`);
  }
}

/** No such run in this tenant (RLS hides other tenants' runs). */
export class RunNotFoundError extends Error {
  override name = "RunNotFoundError";
  constructor(readonly runId: string) {
    super(`no run ${runId}`);
  }
}

export interface AppendOptions {
  /** The Workflow step writing these events (section 15). Event i gets `${stepKey}:${i}`, so a replayed step
   * can't write its events twice. Left out, `step_key` is null. */
  stepKey?: string;
  /** Running time to add to `runs.active_ms`. */
  activeMs?: number;
}

export interface Appended {
  version: number;
  status: RunStatus;
  events: RunEvent[];
}

interface EventRow extends Record<string, unknown> {
  run_id: string;
  seq: number;
  at: Date | string;
  data: RunEventData;
}

export const toRunEvent = (row: EventRow): RunEvent => ({
  runId: row.run_id,
  seq: Number(row.seq),
  at: new Date(row.at).toISOString(),
  data: row.data,
});

/**
 * Appends `events` to a run's log, if the run is still at `expectedVersion`. One statement bumps `runs.version`
 * (and moves `status`) and inserts the events at `max(seq) + 1` onwards, so either all of it happens or none.
 *
 * The version check is what makes it safe: two writers that read version 4 both try `WHERE version = 4`; the
 * second waits on the first's row lock, then finds version 5 and updates nothing, so it inserts nothing and gets
 * a `VersionConflictError`. Status changes go through the state machine first: an illegal one throws.
 */
export async function append(
  tx: Tx,
  runId: string,
  expectedVersion: number,
  events: readonly RunEventData[],
  options: AppendOptions = {},
): Promise<Appended> {
  // 🐨 Read the run's `status` and `version` (`SELECT ... FROM runs WHERE id = ...`). No row: throw a
  //    RunNotFoundError (row-level security, RLS: Postgres hides other tenants' rows, so another tenant's run
  //    isn't found either, and that's the answer for them too).
  // 🐨 If its version isn't `expectedVersion`, throw a VersionConflictError(runId, expectedVersion, <its version>).
  // 🐨 Run the batch through the state machine, `applyStatus(<its status>, events)`: an illegal move throws before
  //    anything is written. Keep the status it returns. An empty batch writes nothing: return the run as it is.
  // 🐨 Then, in ONE statement:
  //    - update the run, but only `WHERE id = ... AND version = <expectedVersion> AND status = <the status you
  //      read>`: version one more, the new status, `active_ms` plus `options.activeMs` (rounded, never negative),
  //      `updated_at` now, and `finished_at` now when the new status is final (keep an earlier one);
  //    - insert the events, numbered from the log's current `max(seq)` (0 for an empty log) plus 1, 2, 3...
  //      in the batch's order, each with `type` from its data and `step_key` `<options.stepKey>:<i>` (i from 0),
  //      or null when there's no step key;
  //    - but only for a run the update actually changed.
  //    Return the new version, the status and the inserted events (as RunEvents, in seq order).
  // 🐨 If the statement inserted nothing, another writer got there between your read and your write: throw
  //    VersionConflictError(runId, expectedVersion, null). Never retry inside `append`: the caller decided
  //    what to write from the version it read, so it has to read again and decide again (step 5 does that).
  //
  // 💰 Import `applyStatus` and `isFinal` from "#learn/agent/state".
  // 💰 A data-modifying CTE: `WITH bumped AS (UPDATE runs SET ... WHERE ... RETURNING id, tenant_id, version)`.
  //    Later CTEs and the main statement read its rows like a table's. `coalesce(max(seq), 0)` is 0 for no rows.
  //    `INSERT INTO t (...) SELECT ... FROM a, b, c` inserts one row per row of the join.
  // 💰 `jsonb_array_elements(${JSON.stringify(items)}::jsonb) WITH ORDINALITY AS e(item, ord)` turns a JSON
  //    array into rows, each with its position from 1. `item -> 'data'` is a jsonb field, `->>` the same as text.
  // 💰 `RETURNING run_id, seq, at, data` gives back the inserted rows; `toRunEvent` turns one into a RunEvent. A
  //    scalar subquery, `(SELECT version FROM bumped)`, can ride along in the same RETURNING.
  //
  // 🦉 Why `WHERE version = <expected>` in the UPDATE, when you've already checked it. Your SELECT and your
  //    UPDATE are two moments. Two writers can both read version 10 before either writes. The first UPDATE
  //    takes the run's row lock and moves it to 11. The second waits on that lock, and when it gets the row,
  //    Postgres checks the WHERE again against the row as it is now: version 11, so it updates nothing. The
  //    check in JavaScript turns away a writer that's clearly behind; the WHERE is the one that decides a race.
  // 🦉 Why seq = max + 1 in the same statement as the guarded UPDATE. Whoever numbers the events must be the
  //    writer that won the run's row. Here the INSERT takes its rows from the UPDATE that won, so a writer that
  //    lost never numbers anything. The classic mistake reads max(seq) and inserts in a statement of its own,
  //    apart from the version check: insert first and update after, and the loser of a race computes the same
  //    seq 13 as the winner and dies on the primary key `(run_id, seq)` with a duplicate-key error (with no such
  //    key, the log would hold two events at seq 13). In one statement, the question never comes up.
  // 🦉 Why one statement and not two in a transaction. One statement is all or nothing on its own, so a version
  //    is never bumped without its events, whatever transaction the caller did or didn't open.
  // 🦉 Why optimistic and not a lock. A runner can spend 10 seconds on a model turn before it appends. Holding
  //    a lock that long would block the cancel button and every approval. Here nobody waits: the loser finds
  //    out when it writes, rereads, and decides again with what the winner added.
  //
  // 📜 https://www.postgresql.org/docs/current/queries-with.html#QUERIES-WITH-MODIFYING
  // 📜 https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED (what an UPDATE does when
  //    the row it waited for has changed)
  //
  // 🚨 The tests replay Leo's recorded run as its 15 appends, race 8 writers at one version, hold one writer's
  //    transaction open while another waits, and check a stale writer, an illegal move and step keys.
  throw new Error(
    `append(${typeof tx}, run ${runId}, version ${expectedVersion}, ${events.length} events, ${JSON.stringify(options)}) isn't written yet`,
  );
}

/** A run's events after `afterSeq`, in order. */
export async function readEvents(tx: Tx, runId: string, afterSeq = 0, limit = 1000): Promise<RunEvent[]> {
  const rows = await tx.execute<EventRow>(sql`
    SELECT run_id, seq, at, data FROM run_events
    WHERE run_id = ${runId} AND seq > ${afterSeq}
    ORDER BY seq
    LIMIT ${limit}`);
  return rows.map(toRunEvent);
}
