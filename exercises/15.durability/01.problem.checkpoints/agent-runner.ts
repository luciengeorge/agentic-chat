// 👨‍💼 With `AGENT_RUNNER=queue`, Grace's run lives on section 05's job queue: two workers in the dev server take
//    one job at a time. Each job is one checkpoint. A worker can be killed mid-job (a deploy, an out-of-memory
//    kill, Ctrl+C), and its job comes back once its lease runs out. What the job does with each outcome, and each
//    failure, decides whether the run finishes, stalls, or fails for nothing.

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
  // 🐨 The job acts for the run's user: `{ tenantId: job.tenantId, userId: job.payload.userId }`.
  // 🐨 An `expire` job settles its approval (`deps.expire`) and, if it did, queues the run's next step: the run
  //    carries on without the write. Nothing else.
  // 🐨 A `step` job opens the run (`deps.open`; nothing to do when it's gone), takes this process's cancel switch
  //    for it (`deps.hold`) and does one `advance`, with:
  //    - the step key `job:<the job's id>`;
  //    - a signal that aborts on either the worker's `signal` or the cancel switch's.
  //    Then: `continue` queues the next step; `waiting` on an approval queues its expiry; and either way kick the
  //    workers. Release the cancel switch however the job ends.
  // 🐨 When `advance` throws, the order of the checks matters:
  //    1. the user cancelled (the switch's signal aborted): the run is already final, so just return, even when
  //       the worker's `signal` aborted too (the server stopping as Grace cancels);
  //    2. the worker stopped or lost its lease (`signal` aborted): throw it, so the job comes back;
  //    3. a failure that could pass (`isRetryable`) with attempts left (`job.attempts < job.maxAttempts`): tell
  //       `deps.onRetry` and throw, so the queue backs off and tries again;
  //    4. anything else: fail the run with the error's message (`failRun`), and return. The job is done.
  //
  // 💰 Import `advance` and `failRun` from "#learn/agent/checkpoint", and `isRetryable` from
  //    "#learn/agent/durable".
  // 💰 `AbortSignal.any([a, b])` aborts when either does. `try { ... } catch { ... } finally { ... }`.
  //
  // 🦉 Why the key is the job's id, and not a fresh id per attempt. A job that comes back after a crash is the
  //    same row, with the same id, and `attempts` one higher. Its step key is how it recognises its own work in
  //    the log. Add the attempt, or a random id, and a redone job can't tell its work is done: it does the next
  //    piece under a new name, alongside the job that's already queued for it.
  // 🦉 Why a lost lease throws instead of failing the run. The worker didn't fail: it was told to stop (the
  //    server is shutting down, or another worker has the job now). The run is fine. Throwing hands the job back
  //    to the queue; failing the run would end Grace's run for a deploy.
  // 🦉 Why a 400 fails the run and a 503 doesn't. A 503 (or a 429, a dropped connection) may pass: the queue
  //    tries again after its backoff, 1 s then 2 s then 4 s. A 400 says the request itself is wrong, and five more
  //    tries would send the same request five more times. On the last attempt even a 503 fails the run, rather
  //    than leave it `running` forever: the job goes `dead`, and nothing else would finish the run.
  // 🦉 Why the expiry is a job of its own. An approval waits up to 7 days. Nothing holds a worker for a week: the
  //    expiry job sits in `jobs` with `run_at` at the approval's `expiresAt`, and survives every restart in between.
  //
  // 🚨 The tests drive Grace's recorded run on the queue: 8 jobs to her approval, a worker killed mid-send and
  //    its job taken back after its lease, a redone job that does nothing twice, a lost lease, a 503, a 400, a
  //    cancel, a cancel that lands as the worker stops (the cancel wins: no throw), and an approval that expires.
  throw new Error(`checkpointJob(job ${job.id}, aborted ${signal.aborted}, ${typeof deps}) isn't written yet`);
}
