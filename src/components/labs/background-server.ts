/**
 * The background lab's server side (section 05): a board of the viewer's tenant's jobs and outbox rows, and a
 * demo of section 05.6's race on a queue of its own. The demo enqueues as the app does, in the tenant, and claims
 * through `#learn/queue/queue` (the learner's code while a queue step is active) on the owner's pool, as workers do.
 * Server only: the route's server functions import it.
 */
import { sql } from "drizzle-orm";

import type { Exec, Transactor } from "#learn/queue/queue";
import type { Tx } from "@/db/tenant";

import { claim, claimWithinLimits, enqueue } from "#learn/queue/queue";

export interface BackgroundLabDeps {
  withTenant: <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** The owner's pool: workers claim across tenants. */
  owner: Exec & Transactor;
}

/** Two workers, as the dev server runs them, and section 05.6's cap: backfill may take one of them. */
export const LAB_WORKERS = ["worker-a", "worker-b"] as const;
export const LAB_LIMITS = { backfill: 1 };
/** Long enough that a claimed job stays running until the lab finishes it. */
const LEASE_MS = 10 * 60_000;

/** The demo's queue, one per tenant, so two tenants' demos never meet. */
export const labQueue = (tenantId: string) => `lab-background:${tenantId}`;

export interface BoardCell {
  queue: string;
  class: string;
  state: string;
  jobs: number;
}

export interface LabJob {
  id: string;
  class: string;
  state: string;
  attempts: number;
  lockedBy: string | null;
  label: string;
}

export interface Board {
  /** Every queue of the tenant, by class and state. */
  cells: BoardCell[];
  /** The demo queue's jobs, oldest first. */
  jobs: LabJob[];
  outbox: { pending: number; published: number; claimed: number; failed: number };
  recentOutbox: {
    id: string;
    kind: string;
    partitionKey: string;
    state: string;
    attempts: number;
    lastError: string | null;
  }[];
}

export async function board(deps: BackgroundLabDeps, tenantId: string): Promise<Board> {
  return deps.withTenant(tenantId, async (tx) => {
    const cells = await tx.execute<{ queue: string; class: string; state: string; jobs: number }>(sql`
      SELECT queue, class, state, count(*)::int AS jobs FROM jobs GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`);
    const jobs = await tx.execute<{
      id: string;
      class: string;
      state: string;
      attempts: number;
      locked_by: string | null;
      payload: Record<string, unknown>;
    }>(sql`
      SELECT id, class, state, attempts, locked_by, payload FROM jobs
      WHERE queue = ${labQueue(tenantId)} ORDER BY created_at, id`);
    const [outbox] = await tx.execute<Board["outbox"]>(sql`
      SELECT
        count(*) FILTER (WHERE published_at IS NULL AND failed_at IS NULL)::int AS pending,
        count(*) FILTER (WHERE published_at IS NOT NULL AND claimed_by IS NULL)::int AS published,
        count(*) FILTER (WHERE claimed_by IS NOT NULL)::int AS claimed,
        count(*) FILTER (WHERE failed_at IS NOT NULL)::int AS failed
      FROM outbox`);
    const recent = await tx.execute<{
      id: string;
      kind: string;
      partition_key: string;
      published: boolean;
      claimed: boolean;
      failed: boolean;
      attempts: number;
      last_error: string | null;
    }>(sql`
      SELECT id, kind, partition_key, published_at IS NOT NULL AS published, claimed_by IS NOT NULL AS claimed,
        failed_at IS NOT NULL AS failed, attempts, last_error
      FROM outbox ORDER BY created_at DESC, id LIMIT 10`);
    return {
      cells: cells.map((cell) => ({ ...cell, jobs: Number(cell.jobs) })),
      jobs: jobs.map((job) => ({
        id: job.id,
        class: job.class,
        state: job.state,
        attempts: Number(job.attempts),
        lockedBy: job.locked_by,
        label:
          job.class === "backfill" ? `pages ${job.payload.from} to ${job.payload.to}` : `delta (${job.payload.reason})`,
      })),
      outbox,
      recentOutbox: recent.map((row) => ({
        id: row.id,
        kind: row.kind,
        partitionKey: row.partition_key,
        state: row.failed ? "failed" : row.claimed ? "claimed" : row.published ? "published" : "pending",
        attempts: Number(row.attempts),
        lastError: row.last_error,
      })),
    };
  });
}

export type LabAction = "backfill" | "delta" | "claim" | "finish" | "clear";

/**
 * One move of the demo. `backfill` queues the filing's twelve page ranges; `delta` queues a webhook's delta;
 * `claim` lets each idle worker claim one job, capped or not; `finish` completes the running jobs; `clear` empties
 * the demo queue. Returns what each worker took, for `claim`, or what `claim` threw.
 */
export async function act(
  deps: BackgroundLabDeps,
  tenantId: string,
  action: LabAction,
  capped: boolean,
): Promise<{ claimed: { worker: string; job: string | null }[]; error: string | null }> {
  const queue = labQueue(tenantId);
  const claimed: { worker: string; job: string | null }[] = [];
  if (action === "backfill") {
    // One transaction each, so their creation times put them in page order, as a sync's would be.
    for (let i = 0; i < 12; i++) {
      const range = { documentId: "filing", from: i * 250 + 1, to: (i + 1) * 250 };
      await deps.withTenant(tenantId, (tx) => enqueue(tx, tenantId, queue, range, { class: "backfill" }));
    }
  } else if (action === "delta") {
    await deps.withTenant(tenantId, (tx) =>
      enqueue(tx, tenantId, queue, { sync: "delta", reason: "webhook" }, { class: "incremental" }),
    );
  } else if (action === "claim") {
    const busy = await deps.owner.execute<{ locked_by: string }>(sql`
      SELECT locked_by FROM jobs WHERE queue = ${queue} AND state = 'running'`);
    try {
      for (const worker of LAB_WORKERS) {
        if (busy.some((row) => row.locked_by === worker)) continue;
        const job = capped
          ? await claimWithinLimits(deps.owner, queue, worker, LEASE_MS, LAB_LIMITS)
          : await claim(deps.owner, queue, worker, LEASE_MS);
        claimed.push({ worker, job: job?.id ?? null });
      }
    } catch (error) {
      return { claimed, error: (error as Error).message };
    }
  } else if (action === "finish") {
    await deps.owner.execute(sql`
      UPDATE jobs SET state = 'done', locked_by = NULL, locked_until = NULL, finished_at = now(), updated_at = now()
      WHERE queue = ${queue} AND state = 'running'`);
  } else {
    await deps.owner.execute(sql`DELETE FROM jobs WHERE queue = ${queue}`);
  }
  return { claimed, error: null };
}
