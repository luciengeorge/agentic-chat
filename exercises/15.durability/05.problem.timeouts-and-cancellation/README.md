---
title: Timeouts and cancellation
type: graded
slots:
  agent/durable-run: durable-run.ts
  agent/durable: durable.ts
---

# Timeouts and cancellation

👨‍💼 Grace presses Cancel while the agent is mid-turn. In step 3 the turn ran to its end anyway, billing up to 2,000 more output tokens for a run she had stopped, and the cancel only showed at the next plan. Elsewhere a model call hangs: the provider took the request and never answers. Both have to end now, and only the hung one is worth another try.

## Terms

- An **abort signal** tells work in flight to stop. The workflow has one `AbortController`; its signal goes into every step, and the loop hands it to the AI SDK as `abortSignal`, which closes the model's HTTP request. Workflow carries an abort from the body into a step that's running.
- The **step timeout** is how long one model turn may take before the step gives up on it: `STEP_TIMEOUT_MS`, 120 seconds (300 ms in the test).
- A **`RetryableError`** asks Workflow to run the step again after `retryAfter`; a **`FatalError`** ends the step for good. A model turn step tries up to `maxRetries` (3) more times.
- **Backoff**: waiting longer before each retry, here `backoffMs`: 1 s, 2 s, 4 s.

## Do this

🐨 In `playground/durable-run.ts`, write `unlessCancelled`: the work, unless a cancel comes first. `driveRun` already wraps every model turn and every batch of tool calls in it.

🐨 In `playground/durable.ts`, write `turnFailure`: what a model turn step does after its turn threw. The step (`modelTurnStep` in `src/workflows/agent-run-steps.ts`) turns your answer into a rethrow, a failed run, a `RetryableError` or a `FatalError`.

🚨 The classic mistake is to read a cancel as a failure. An aborted call throws something like "This operation was aborted"; sorted as an error, Grace's cancel is retried or ends her run `failed`. Look at the run's signal first.

## A worked example

Grace's third model turn (after the search and the person lookup) hangs. She cancels. `cancelRun` writes `running -> cancelled` at seq 8, version 7, and the waker resumes the run's hook with `{ kind: "cancel" }`. Your `unlessCancelled` sees it, aborts the controller, the hung call is aborted, and the workflow returns `cancelled`. The log ends at seq 8: no turn from the aborted call.

In a second run, her first model call hangs and the step's timer (300 ms here) gives up on it. That's a retry: Workflow runs the step again 1 ms later (`retryAfterMs`, passed in as data), attempt 2 goes through, and the run reaches her approval with four turns, each written once.

Run the tests with `pnpm ex test 15.5`. They need Postgres (`pnpm ex up`).
