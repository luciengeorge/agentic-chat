/**
 * Agent runs on the hand-built job queue (section 15.1). Each job is one checkpoint: `advance` reads the run's log,
 * decides, does one piece of work and appends it, under the job's own step key. Then the job queues the run's next
 * checkpoint. A worker that dies mid-job loses its lease; the job comes back with the same id, so the redone step
 * finds what it already wrote instead of writing it twice.
 *
 * Everything that touches the app (Postgres, the runtime, this process's cancel switch) comes in through `deps`;
 * `src/lib/agent-queue.ts` binds it.
 */
import type { OpenApproval, StepLoop, StepStore } from "#learn/agent/checkpoint";
import type { Job } from "#learn/queue/queue";
import type { Viewer } from "#learn/retrieve/types";

import { advance, failRun } from "#learn/agent/checkpoint";
import { isRetryable } from "#learn/agent/durable";

export type AgentJob =
  | { kind: "step"; runId: string; userId: string }
  | { kind: "expire"; runId: string; userId: string; approvalId: string };

export interface AgentJobDeps {
  /** The run's log and its loop, bound to its user; null when there's no such run. */
  open(viewer: Viewer, runId: string): Promise<{ store: StepStore; loop: StepLoop } | null>;
  /** Queues the run's next checkpoint (one waits per run at most). */
  queueStep(viewer: Viewer, runId: string): Promise<void>;
  /** Queues the approval's expiry, due when it expires. */
  queueExpiry(viewer: Viewer, runId: string, approval: OpenApproval): Promise<void>;
  /** Settles the approval as expired, if nobody decided it first; true if it did. */
  expire(viewer: Viewer, approvalId: string): Promise<boolean>;
  /** This process's cancel switch for the run: aborted when the user cancels it. */
  hold(runId: string): { signal: AbortSignal; release(): void };
  /** Wakes the workers now, rather than at their next poll. */
  kick(): void;
  /** Told when a checkpoint failed and the job will be tried again. */
  onRetry?(error: unknown, job: Job<AgentJob>): void;
}

/**
 * Does one agent job. `signal` aborts when the worker stops or loses its lease. Throws only for a failure the queue
 * should retry (the job comes back later); a failure that retrying can't fix fails the run instead.
 */
export async function checkpointJob(job: Job<AgentJob>, signal: AbortSignal, deps: AgentJobDeps): Promise<void> {
  const viewer: Viewer = { tenantId: job.tenantId, userId: job.payload.userId };
  const { runId } = job.payload;

  if (job.payload.kind === "expire") {
    if (await deps.expire(viewer, job.payload.approvalId)) await deps.queueStep(viewer, runId);
    return;
  }

  const opened = await deps.open(viewer, runId);
  if (!opened) return;
  const live = deps.hold(runId);
  try {
    const outcome = await advance(opened.store, opened.loop, {
      stepKey: `job:${job.id}`,
      signal: AbortSignal.any([signal, live.signal]),
    });
    if (outcome.kind === "continue") await deps.queueStep(viewer, runId);
    if (outcome.kind === "waiting" && outcome.approval) await deps.queueExpiry(viewer, runId, outcome.approval);
    deps.kick();
  } catch (error) {
    // Cancelled: the run is already final.
    if (live.signal.aborted) return;
    // The worker stopped or lost its lease: the job comes back.
    if (signal.aborted) throw error;
    if (isRetryable(error) && job.attempts < job.maxAttempts) {
      deps.onRetry?.(error, job);
      throw error;
    }
    await failRun(opened.store, error instanceof Error ? error.message : String(error));
  } finally {
    live.release();
  }
}
