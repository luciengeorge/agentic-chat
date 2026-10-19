---
title: Checkpoints and resume
type: graded
slots:
  agent/checkpoint: checkpoint.ts
  queue/agent-runner: agent-runner.ts
---

# Checkpoints and resume: the solution

`advance` calls `plan` and hands back anything that isn't `act`. For `act` it does one step at the plan's version: `modelStep` for a model turn; for tools, unless `store.wrote(stepKey)`, `loop.runTools` then `recordResults` under the same key; for an approval, `store.requestApproval`, returning `waiting` with the approval when it lands. Then `continue`. A `RunHalted` thrown by the guard is caught, `failRun` writes the reason, and the answer is `final, failed`; anything else is thrown on.

`checkpointJob` settles an `expire` job's approval and queues the run's next step if it changed anything. A `step` job opens the run, takes its cancel switch, and runs `advance` with the key `job:<job.id>` and a signal that aborts on the worker's or the switch's. `continue` queues the next step, `waiting` on an approval queues its expiry, and the workers get a kick. On a throw it checks, in order: cancelled (return), the worker's signal (throw), retryable with attempts left (`onRetry`, throw), and otherwise `failRun` with the message. The switch is released in `finally`.

## Why it works

- **The log is the checkpoint.** Nothing else is saved between jobs. A turn's events and the run's new version are one write (14.2), so a step either left its mark or didn't. A worker killed mid-step left nothing, and the next job plans the same step again. A worker killed after its write left a log that already says it, and the next plan moves on.
- **Three guards, three jobs.** The version refuses a write decided from an old log (two workers on one lapsed job: the slower one's turn is `stale` and thrown away). The step key lets a step see that it already wrote, so a redone job does nothing rather than the next job's work. The idempotency key (step 2) covers what the log can't: a mail that left before the crash and was never recorded.
- **The job's id is stable, the attempt isn't.** `reclaimExpired` puts the same row back with `attempts + 1`. `job:<id>` matches the first try's events; `job:<id>:<attempts>` never does.
- **Who decides a retry.** `advance` can't know whether a 503 deserves another try: the queue can, from `attempts` and `max_attempts`. A lost lease is the worker's problem, never the run's, so it goes back to the queue. A cancel isn't a failure at all. Only what retrying can't fix, or the last attempt, fails the run, because a dead job leaves nobody to finish it.
- **Waiting costs nothing.** A waiting run has no job running. Its approval's expiry is a row with `run_at` 7 days out, which survives any number of restarts; a decision before then queues the next step, and the expiry finds the approval already decided and does nothing.

## The worked example

Grace's run takes 8 jobs to `waiting`, with the expiry queued at `expiresAt`. After her approval, the worker that claims the send (150 ms lease) is killed with the mail in flight; the run stays `running`. `reclaimExpired` answers `{ requeued: 1, dead: 0 }`, and 3 more jobs finish it: `succeeded`, 17 events at version 15, one `tool_result` for `call_4NmkEZ5nioB2ceFw1vL09fLI`. The mailroom saw `agent:<run>:call_4NmkEZ5nioB2ceFw1vL09fLI` twice and kept one mail. With the app's 30-second lease, the same crash costs the run 30 seconds.
