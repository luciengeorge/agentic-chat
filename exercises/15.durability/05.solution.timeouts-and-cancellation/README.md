---
title: Timeouts and cancellation
type: graded
slots:
  agent/durable-run: durable-run.ts
  agent/durable: durable.ts
---

# Timeouts and cancellation: the solution

`unlessCancelled` loops on a race between the work (tagged `work: true`) and `signals.pending`. The work winning returns `{ value }`. A signal winning is taken; a wake goes round again, racing the same work; a cancel calls `controller.abort("cancelled")`, awaits the work with its error dropped, and returns null.

`turnFailure` checks, in order: `cancelled` from the context; a `RunHalted` (halted, with its reason); the step's timeout or `isRetryable(error)` (retry, with the message and `retryAfterMs ?? backoffMs(attempt)`); anything else is fatal, with the message.

## Why it works

- **One controller reaches every step.** Workflow's `AbortController` in the body is durable: aborting it is recorded, and the step that's running sees its signal abort. `modelTurnStep` combines it with its own timeout (`AbortSignal.any`), the loop passes it to the AI SDK, and the model's HTTP request is closed. The provider stops streaming and stops billing.
- **Wait for the work to stop.** After the abort the step is still running until it notices. Awaiting it means the body ends after its last step, and no step is left writing after the run is over. The step's own rejection is expected, so it's dropped.
- **A wake isn't a cancel.** A message landing mid-turn is in Postgres already; the next plan reads it. The turn in flight carries on, and the race goes round again with the next read of the run's hook. Taking the fired read each time is what lets a cancel after a wake be heard.
- **The cancel is already written.** `cancelRun` appended `-> cancelled` before it woke the workflow, so even if the abort came too late, the turn's append would find a newer version and be thrown away as stale. The abort saves the tokens; the version keeps the log right.
- **Sort by cause, not by message.** The run's signal says "cancelled" whatever the call threw, so it's asked first. The step's timer says "timed out" whatever the SDK made of the abort. Then `isRetryable` reads status codes and network codes through `cause` chains. Only a 400 or a bug ends the step at once.
- **The numbers fit together.** The step gives up at 120 s; the local world's ownership lease is 150 s, just above it, so a slow step is never taken for dead; Workflow's default lease is 860 s, sized for Vercel. Retries wait `retryAfter`, which Workflow enforces in real time, so it's data: 1 ms in tests, the 1-2-4 s backoff in the app.

## The worked example

The third turn hangs; the cancel lands at seq 8, version 7, and the workflow returns `cancelled` with the call aborted and nothing after seq 8. With a 300 ms step timeout and a first call that hangs, `modelTurnStep` is retried and completes on attempt 2; the run reaches her approval with four turns, each once.
