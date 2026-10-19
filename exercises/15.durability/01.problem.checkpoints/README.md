---
title: Checkpoints and resume
type: graded
slots:
  agent/checkpoint: checkpoint.ts
  queue/agent-runner: agent-runner.ts
---

# Checkpoints and resume

👨‍💼 Grace Adeyemi asks the agent: "Email Tom Whitfield a two-line summary of the payment terms in contract KPC-2026-0142." Her run is a dozen pieces of work, and today it runs inside one request. Kill the server between the search and the send, and the run sits at `running` forever: nothing picks it up. Put it on section 05's job queue instead, one piece per job, and a crash costs one piece.

## Terms

- A **checkpoint** is a point a crashed program can resume from. Here it's the run's event log (section 14): each piece of work appends what it did, and the next piece starts by reading the log.
- A **step** is one piece of work: a model turn, a turn's tool calls, or an approval request. One checkpoint does one step.
- The **step key** names the step that wrote an event: event i of a write gets `step_key` `<key>:<i>` (your 14.2 `append`), and the column is unique per run. On the queue the key is `job:<the job's id>`.
- A **lease** is how long a worker may hold a job without checking in (section 05.1). 30 seconds in the app, renewed every 10. A killed worker stops renewing it, and `reclaimExpired` queues its job again, **with the same id** and one more attempt.
- **Retryable** means a later try could work: a 429, a 5xx, a dropped connection (`isRetryable`). A 400 isn't.

## What's already written

In `checkpoint.ts`:

- `StepStore`, the run's log for one viewer: `load` it, `append` at a version (false when another writer got in first), ask whether a step key `wrote`, `requestApproval`.
- `StepLoop`, section 13's loop bound to the run: `decide`, `modelTurn`, `runTools`.
- `plan(store, loop)` reads the log and decides. It makes the moves that only change the status (claim, wait, finish) itself, and hands back `act`: the work, and the version to write it at.
- `modelStep` does one model turn and appends it under the step key; `stale` when the log moved first.
- `recordResults` appends a turn's tool results, in call order, once.
- `failRun` ends the run `failed`, from whatever status it's in.

In `agent-runner.ts`, `AgentJobDeps` is all the job needs from the app (`src/lib/agent-queue.ts` binds it): `open` (the run's store and loop), `queueStep` (the next checkpoint's job), `queueExpiry` and `expire` (the approval's timer), `hold` (this process's cancel switch for the run), `kick` (wake the workers now) and `onRetry`.

## Do this

🐨 In `playground/checkpoint.ts`, write `advance`: plan, then the one step the plan calls for, under the caller's step key.

🐨 In `playground/agent-runner.ts`, write `checkpointJob`: what one job on the queue does with each outcome of `advance`, and with each way it can fail. `src/lib/agent-queue.ts` binds its `deps` to Postgres and runs it in the dev server's two workers (`AGENT_RUNNER=queue`).

🚨 The classic mistake is a step key that changes when the job comes back: the attempt number in it, or a random id. The redone job can't find its own work in the log, so it does the next step under a new name, next to the job already queued for it. The key is `job:<job.id>`, nothing else.

## A worked example

Grace's run, replayed from section 13's recording on the queue. Eight jobs take it to her approval: the plan's turn, `make_plan`, a turn with `search_documents` and `find_person`, both results, a turn with `read_document`, its result, the turn that drafts `send_mail`, and the approval request (`running -> waiting`, due in 7 days). Its expiry waits in `jobs` as a ninth.

She approves. A worker claims the send with a 150 ms lease and is killed while the mail is in flight. The run is still `running`. 200 ms later `reclaimExpired` finds the lease run out and queues the job again. Three more jobs: the send again, the answer, the finish. The run ends `succeeded` with 17 events at version 15, and the mail went out twice under one key, `agent:<run>:call_4NmkEZ5nioB2ceFw1vL09fLI`, so fake-workspace kept one.

Run the tests with `pnpm ex test 15.1`. They need Postgres (`pnpm ex up`).
