import { sql } from "drizzle-orm";

import type { RunEvent, RunEventData, RunStatus } from "#learn/agent/types";
import type { Tx } from "@/db/tenant";

import { applyStatus, isFinal } from "#learn/agent/state";

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
  const [run] = await tx.execute<{ status: RunStatus; version: number }>(
    sql`SELECT status, version FROM runs WHERE id = ${runId}`,
  );
  if (!run) throw new RunNotFoundError(runId);
  if (run.version !== expectedVersion) throw new VersionConflictError(runId, expectedVersion, run.version);
  const status = applyStatus(run.status, events);
  if (events.length === 0) return { version: run.version, status, events: [] };

  const items = events.map((data, i) => ({
    data,
    stepKey: options.stepKey === undefined ? null : `${options.stepKey}:${i}`,
  }));
  const rows = await tx.execute<EventRow & { version: number }>(sql`
    WITH bumped AS (
      UPDATE runs
      SET version = version + 1,
        status = ${status},
        active_ms = active_ms + ${Math.max(0, Math.round(options.activeMs ?? 0))},
        updated_at = now(),
        finished_at = CASE WHEN ${isFinal(status)}::boolean THEN coalesce(finished_at, now()) ELSE finished_at END
      WHERE id = ${runId} AND version = ${expectedVersion} AND status = ${run.status}
      RETURNING id, tenant_id, version
    ),
    last AS (SELECT coalesce(max(seq), 0) AS seq FROM run_events WHERE run_id = ${runId})
    INSERT INTO run_events (tenant_id, run_id, seq, type, data, step_key)
    SELECT b.tenant_id, b.id, last.seq + e.ord, e.item -> 'data' ->> 'type', e.item -> 'data', e.item ->> 'stepKey'
    FROM bumped b, last, jsonb_array_elements(${JSON.stringify(items)}::jsonb) WITH ORDINALITY AS e(item, ord)
    RETURNING run_id, seq, at, data, (SELECT version FROM bumped) AS version`);
  if (rows.length === 0) throw new VersionConflictError(runId, expectedVersion, null);
  return { version: Number(rows[0].version), status, events: rows.map(toRunEvent).sort((a, b) => a.seq - b.seq) };
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

/** One event as an SSE message. `id` is its `seq`, so a client that reconnects sends it back as Last-Event-ID. */
export const toSse = (event: RunEvent) => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
