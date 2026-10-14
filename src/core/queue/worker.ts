/**
 * The worker loop: take back expired leases, claim a job, work it under a heartbeat, then complete or fail it.
 * One job at a time; run several workers for more.
 */
import { randomUUID } from "node:crypto";

import {
  claim,
  claimWithinLimits,
  type ClassLimits,
  complete,
  type Exec,
  fail,
  heartbeat,
  type Job,
  reclaimExpired,
  type Transactor,
} from "./queue";

export interface WorkerOptions<P> {
  /** Runs each statement on its own (the owner's pool: a worker crosses tenants). */
  db: Exec | (Exec & Transactor);
  queue: string;
  /** Caps per job class, so a backfill can't take every worker (`claimWithinLimits`). Needs `db` to be a pool. */
  classLimits?: ClassLimits;
  /** Does the job. `signal` aborts when the worker stops or loses the lease. A throw fails the attempt. */
  handler: (job: Job<P>, signal: AbortSignal) => Promise<void>;
  workerId?: string;
  leaseMs?: number;
  /** How long to sleep when the queue is empty. */
  pollMs?: number;
  /** The wait before a failed job runs again, from its attempt count. */
  retryInMs?: (attempts: number) => number;
  signal?: AbortSignal;
  onError?: (error: unknown, job: Job<P> | null) => void;
}

export const DEFAULT_LEASE_MS = 30_000;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Works one job: heartbeats every third of the lease, and aborts the handler if the lease is lost. */
export async function workJob<P>(options: WorkerOptions<P>, job: Job<P>, workerId: string): Promise<void> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const controller = new AbortController();
  const stop = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", stop, { once: true });
  const beat = setInterval(() => {
    heartbeat(options.db, job, workerId, leaseMs).then(
      (held) => held || controller.abort(new Error("lease lost")),
      (error: unknown) => options.onError?.(error, job),
    );
  }, leaseMs / 3);
  try {
    await options.handler(job, controller.signal);
    await complete(options.db, job, workerId);
  } catch (error) {
    options.onError?.(error, job);
    const retryInMs = options.retryInMs?.(job.attempts) ?? Math.min(60_000, 1_000 * 2 ** (job.attempts - 1));
    await fail(options.db, job, workerId, message(error), retryInMs);
  } finally {
    clearInterval(beat);
    options.signal?.removeEventListener("abort", stop);
  }
}

function pool(db: WorkerOptions<unknown>["db"]): Transactor {
  if (!("transaction" in db)) throw new Error("class limits claim in a transaction: give the worker a pool");
  return db;
}

/** Claims and works one due job. False when there was none. */
export async function workOnce<P>(options: WorkerOptions<P>, workerId = options.workerId ?? randomUUID()) {
  await reclaimExpired(options.db, options.queue);
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const job = options.classLimits
    ? await claimWithinLimits<P>(pool(options.db), options.queue, workerId, leaseMs, options.classLimits)
    : await claim<P>(options.db, options.queue, workerId, leaseMs);
  if (!job) return false;
  await workJob(options, job, workerId);
  return true;
}

/** Loops until `signal` aborts. `wakeUp` lets a caller skip the poll's sleep after enqueueing. */
export async function runWorker<P>(
  options: WorkerOptions<P>,
  wakeUp?: (listener: () => void) => () => void,
): Promise<void> {
  const workerId = options.workerId ?? randomUUID();
  let nudge: () => void = () => {};
  const unsubscribe = wakeUp?.(() => nudge());
  try {
    while (!options.signal?.aborted) {
      let worked = false;
      try {
        worked = await workOnce(options, workerId);
      } catch (error) {
        options.onError?.(error, null);
      }
      if (worked) continue;
      const poke = new AbortController();
      nudge = () => poke.abort();
      await sleep(
        options.pollMs ?? 1_000,
        options.signal ? AbortSignal.any([options.signal, poke.signal]) : poke.signal,
      );
    }
  } finally {
    unsubscribe?.();
  }
}
