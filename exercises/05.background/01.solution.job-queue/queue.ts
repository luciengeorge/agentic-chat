/**
 * A job queue in Postgres, by hand (section 05.1). A worker claims the oldest due job with `FOR UPDATE SKIP LOCKED`,
 * so two workers never take the same one, and holds it under a lease it renews while it works. If the worker dies,
 * the lease runs out and the job goes back on the queue. A job that keeps failing goes `dead` after
 * `max_attempts`, so one poison job can't block the queue forever.
 *
 * Jobs that share a `key` (say, one agent run) run one at a time, and only one of them waits in `queued`: enqueue
 * the same key again and the waiting job is reused.
 *
 * Every job has a class (say `backfill` or `incremental`). A worker can cap how many jobs of a class run at once
 * (`claimWithinLimits`), so a full sync's thousands of jobs, queued first, can't hold every worker while a
 * webhook's small delta waits behind them (section 05.5).
 *
 * Every function takes the executor to run on. Workers cross tenants, so they use the owner (`systemDb`); an app
 * request enqueues inside its tenant's transaction, so the job commits with the write it stands for.
 */
import { sql } from "drizzle-orm";

import type { Tx } from "@/db/tenant";

export type Exec = Pick<Tx, "execute">;

/** A pool that can open a transaction: what `claimWithinLimits` needs to count and claim under one lock. */
export type Transactor = { transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> };

/** The most jobs of each named class that may run at once on a queue. A class not named has no cap. */
export type ClassLimits = Record<string, number>;

export const DEFAULT_CLASS = "default";

export type JobState = "queued" | "running" | "done" | "dead";

export interface Job<P = Record<string, unknown>> {
  id: string;
  tenantId: string;
  queue: string;
  key: string | null;
  class: string;
  payload: P;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  lockedBy: string | null;
  lastError: string | null;
}

export interface EnqueueOptions {
  /** Jobs with one key run one at a time; a second enqueue while one waits reuses it. */
  key?: string;
  /** Not before this long from now. */
  delayMs?: number;
  maxAttempts?: number;
  /** The kind of work, for per-class caps: `backfill`, `incremental`... (default `default`). */
  class?: string;
}

interface JobRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  queue: string;
  key: string | null;
  class: string;
  payload: unknown;
  state: JobState;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  last_error: string | null;
}

export const toJob = <P>(row: JobRow): Job<P> => ({
  id: row.id,
  tenantId: row.tenant_id,
  queue: row.queue,
  key: row.key,
  class: row.class,
  payload: row.payload as P,
  state: row.state,
  attempts: Number(row.attempts),
  maxAttempts: Number(row.max_attempts),
  lockedBy: row.locked_by,
  lastError: row.last_error,
});

const interval = (ms: number) => sql`(${Math.max(0, Math.round(ms))} * interval '1 millisecond')`;

/** Adds a job, or, when one with the same key is already waiting, moves that one earlier if this one is due
 * sooner. Returns the waiting job's id. */
export async function enqueue(
  tx: Exec,
  tenantId: string,
  queue: string,
  payload: Record<string, unknown>,
  options: EnqueueOptions = {},
): Promise<string> {
  const [row] = await tx.execute<{ id: string }>(sql`
    INSERT INTO jobs (tenant_id, queue, key, payload, run_at, max_attempts, class)
    VALUES (${tenantId}, ${queue}, ${options.key ?? null}, ${JSON.stringify(payload)}::jsonb,
      now() + ${interval(options.delayMs ?? 0)}, ${options.maxAttempts ?? 5}, ${options.class ?? DEFAULT_CLASS})
    ON CONFLICT (queue, key) WHERE state = 'queued' AND key IS NOT NULL
    DO UPDATE SET run_at = least(jobs.run_at, EXCLUDED.run_at), updated_at = now()
    RETURNING id`);
  return row.id;
}

/** A job whose key has another job running (with a live lease) waits its turn: one job per key at a time. */
export const keyFree = sql`(j.key IS NULL OR NOT EXISTS (
  SELECT 1 FROM jobs r
  WHERE r.queue = j.queue AND r.key = j.key AND r.state = 'running' AND r.locked_until > now()))`;

/**
 * Takes the oldest due job on `queue` for `workerId`, for `leaseMs`, and counts the attempt. `SKIP LOCKED` passes
 * over rows another worker is claiming at this moment instead of waiting on them, so concurrent claims each get a
 * different job. A job whose key has another job running (with a live lease) waits its turn.
 */
export async function claim<P = Record<string, unknown>>(
  tx: Exec,
  queue: string,
  workerId: string,
  leaseMs: number,
): Promise<Job<P> | null> {
  const [row] = await tx.execute<JobRow>(sql`
    WITH next AS (
      SELECT j.id FROM jobs j
      WHERE j.queue = ${queue} AND j.state = 'queued' AND j.run_at <= now() AND ${keyFree}
      ORDER BY j.run_at, j.created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs SET state = 'running', attempts = jobs.attempts + 1, locked_by = ${workerId},
      locked_until = now() + ${interval(leaseMs)}, updated_at = now()
    FROM next WHERE jobs.id = next.id
    RETURNING jobs.*`);
  return row ? toJob<P>(row) : null;
}

/** `claim` with per-class caps: section 05.5 writes it. Until then it claims as `claim` does, whatever the caps. */
export async function claimWithinLimits<P = Record<string, unknown>>(
  db: Transactor,
  queue: string,
  workerId: string,
  leaseMs: number,
  _limits: ClassLimits,
): Promise<Job<P> | null> {
  return db.transaction((tx) => claim<P>(tx, queue, workerId, leaseMs));
}

/** Renews the lease. False when the worker no longer holds the job (its lease ran out and someone took it back):
 * it should stop. */
export async function heartbeat(tx: Exec, job: Job<unknown>, workerId: string, leaseMs: number): Promise<boolean> {
  const rows = await tx.execute(sql`
    UPDATE jobs SET locked_until = now() + ${interval(leaseMs)}, updated_at = now()
    WHERE id = ${job.id} AND state = 'running' AND locked_by = ${workerId}
    RETURNING id`);
  return rows.length > 0;
}

/** Marks the job done. False when the worker had lost it. */
export async function complete(tx: Exec, job: Job<unknown>, workerId: string): Promise<boolean> {
  const rows = await tx.execute(sql`
    UPDATE jobs SET state = 'done', locked_by = NULL, locked_until = NULL, last_error = NULL, finished_at = now(),
      updated_at = now()
    WHERE id = ${job.id} AND state = 'running' AND locked_by = ${workerId}
    RETURNING id`);
  return rows.length > 0;
}

/** Where a failed or abandoned job goes: `dead` once out of attempts; else back to `queued`, unless a job with its
 * key is already waiting there, which does the same work, so this one is `done`. */
const settle = sql`CASE
  WHEN jobs.attempts >= jobs.max_attempts THEN 'dead'
  WHEN jobs.key IS NOT NULL AND EXISTS (
    SELECT 1 FROM jobs q WHERE q.queue = jobs.queue AND q.key = jobs.key AND q.state = 'queued') THEN 'done'
  ELSE 'queued' END`;

/**
 * Records a failure. The job runs again after `retryInMs` (the caller's backoff), or goes `dead` once it has used
 * `max_attempts`. Returns where it went, or null when the worker had lost it.
 */
export async function fail(
  tx: Exec,
  job: Job<unknown>,
  workerId: string,
  error: string,
  retryInMs: number,
): Promise<JobState | null> {
  const [row] = await tx.execute<{ state: JobState }>(sql`
    UPDATE jobs SET state = ${settle}, last_error = ${error.slice(0, 2000)}, locked_by = NULL, locked_until = NULL,
      run_at = now() + ${interval(retryInMs)}, updated_at = now(),
      finished_at = CASE WHEN jobs.attempts >= jobs.max_attempts THEN now() ELSE NULL END
    WHERE id = ${job.id} AND state = 'running' AND locked_by = ${workerId}
    RETURNING state`);
  return row?.state ?? null;
}

/**
 * Takes back jobs whose lease ran out: their worker crashed or hung. Each counts as a failed attempt, so a job that
 * kills its worker every time still goes `dead`.
 */
export async function reclaimExpired(tx: Exec, queue: string): Promise<{ requeued: number; dead: number }> {
  const rows = await tx.execute<{ state: JobState }>(sql`
    UPDATE jobs SET state = ${settle}, last_error = 'lease expired: worker ' || coalesce(locked_by, '?') || ' stopped',
      locked_by = NULL, locked_until = NULL, updated_at = now(),
      finished_at = CASE WHEN jobs.attempts >= jobs.max_attempts THEN now() ELSE NULL END
    WHERE id IN (
      SELECT id FROM jobs WHERE queue = ${queue} AND state = 'running' AND locked_until <= now()
      FOR UPDATE SKIP LOCKED)
    RETURNING state`);
  return {
    requeued: rows.filter((r) => r.state === "queued").length,
    dead: rows.filter((r) => r.state === "dead").length,
  };
}
