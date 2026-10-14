/**
 * The queue runner (`AGENT_RUNNER=queue`, section 15.1): agent runs on the hand-built job queue. Each job is one
 * checkpoint (`advance`), keyed by the run so a run has one job at a time, and enqueues the next. A worker that
 * dies mid-job loses its lease; the job comes back, and the step key (the job id) keeps a redone step from writing
 * twice. Server only.
 */
import type { Viewer } from "#learn/retrieve/types";
import type { Db } from "@/db/create";
import type { Tx } from "@/db/tenant";

import { advance, failRun } from "#learn/agent/checkpoint";
import { backoffMs, isRetryable } from "#learn/agent/durable";
import { enqueue, type Exec, type Job } from "#learn/queue/queue";
import { runWorker } from "#learn/queue/worker";
import { withTenantOn } from "@/db/tenant";
import { expireApproval, holdLive, loadRun, runStore, stepLoop } from "@/lib/agent-runs";
import { type AgentRuntime, agentRuntime } from "@/lib/agent-runtime";
import { createLogger } from "@/lib/logger";

const logger = createLogger("agent.queue");

export const AGENT_QUEUE = "agent-runs";

export type AgentJob =
  | { kind: "step"; runId: string; userId: string }
  | { kind: "expire"; runId: string; userId: string; approvalId: string };

const KICKS = Symbol.for("agentic-chat.agent-queue-kicks");

function kicks(): EventTarget {
  const store = globalThis as typeof globalThis & { [KICKS]?: EventTarget };
  return (store[KICKS] ??= new EventTarget());
}

/** Wakes this process's workers now instead of at their next poll. */
export const kickWorkers = () => kicks().dispatchEvent(new Event("kick"));

/** Queues the run's next checkpoint, in the caller's tenant transaction. One waits per run at most. */
export const enqueueStep = (tx: Exec, viewer: Viewer, runId: string) =>
  enqueue(tx, viewer.tenantId, AGENT_QUEUE, { kind: "step", runId, userId: viewer.userId }, { key: runId });

/** Queues the run's next checkpoint, then wakes the workers. */
export async function kickQueued(db: Db, viewer: Viewer, runId: string): Promise<void> {
  await withTenantOn(db, viewer.tenantId, (tx) => enqueueStep(tx, viewer, runId));
  kickWorkers();
}

/** Does one agent job. Never throws for a failure that retrying can't fix: it fails the run instead. */
export function agentJobHandler(runtime: () => AgentRuntime = agentRuntime) {
  return async (job: Job<AgentJob>, signal: AbortSignal): Promise<void> => {
    const { db, approvalTtlMs } = runtime();
    const viewer: Viewer = { tenantId: job.tenantId, userId: job.payload.userId };
    const { runId } = job.payload;
    const tx = <T>(fn: (tx: Tx) => Promise<T>) => withTenantOn(db, viewer.tenantId, fn);

    if (job.payload.kind === "expire") {
      const { approvalId } = job.payload;
      if (await tx((t) => expireApproval(t, approvalId, { timerFired: true })))
        await tx((t) => enqueueStep(t, viewer, runId));
      return;
    }

    const run = await tx((t) => loadRun(t, viewer, runId));
    if (!run) return;
    const store = runStore(db, viewer, runId, { approvalTtlMs });
    const live = holdLive(runId);
    const both = AbortSignal.any([signal, live.signal]);
    try {
      const outcome = await advance(store, stepLoop(runtime().loop(viewer), viewer, run), {
        stepKey: `job:${job.id}`,
        signal: both,
      });
      if (outcome.kind === "continue") await tx((t) => enqueueStep(t, viewer, runId));
      if (outcome.kind === "waiting" && outcome.approval) {
        const { approvalId, expiresAt } = outcome.approval;
        await tx((t) =>
          enqueue(
            t,
            viewer.tenantId,
            AGENT_QUEUE,
            { kind: "expire", runId, userId: viewer.userId, approvalId },
            { key: `expire:${approvalId}`, delayMs: Date.parse(expiresAt) - Date.now() },
          ),
        );
      }
      kickWorkers();
    } catch (error) {
      // Cancelled: the run is already final.
      if (live.signal.aborted) return;
      // The worker stopped or lost its lease: the job comes back.
      if (signal.aborted) throw error;
      if (isRetryable(error) && job.attempts < job.maxAttempts) {
        logger.warn("checkpoint failed; the job will retry", { runId, error, attempt: job.attempts });
        throw error;
      }
      await failRun(store, error instanceof Error ? error.message : String(error));
    } finally {
      live.release();
    }
  };
}

/** The wait before a failed agent job runs again. */
export const agentRetryInMs =
  (runtime: () => AgentRuntime = agentRuntime) =>
  (attempts: number) =>
    backoffMs(attempts, runtime().retryAfterMs ?? 1_000);

/** Runs `count` workers on the agent queue until `signal` aborts. `db` crosses tenants: the owner. */
export function startAgentWorkers(db: Exec, signal: AbortSignal, count = 2, runtime = agentRuntime) {
  return Promise.all(
    Array.from({ length: count }, () =>
      runWorker<AgentJob>(
        {
          db,
          queue: AGENT_QUEUE,
          handler: agentJobHandler(runtime),
          retryInMs: agentRetryInMs(runtime),
          signal,
          onError: (error, job) => logger.error("agent job failed", { error, jobId: job?.id }),
        },
        (listener) => {
          kicks().addEventListener("kick", listener);
          return () => kicks().removeEventListener("kick", listener);
        },
      ),
    ),
  );
}
