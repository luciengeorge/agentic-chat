---
title: Idempotent side effects
type: graded
slots:
  agent/durable: durable.ts
  agent/tools/workspace: workspace.ts
---

# Idempotent side effects: the solution

`stepIdempotencyKey(runId, stepId)` is `agent:<runId>:<stepId>`. `withIdempotencyKey(tools, key)` maps each tool to a copy whose `execute` calls the original with `{ ...ctx, idempotencyKey: key }`. The Workflow tool step (`toolStep` in `src/workflows/agent-run-steps.ts`) asks `getStepMetadata()` for its `stepId`, builds the key, and the runner's loop wraps the tools with it.

`post` loops over attempts. Each sends the same request: the bearer token, JSON, `idempotency-key` set to the key it was handed, the extra headers, the caller's signal. A 2xx is returned. A 429 or 5xx with retries left drains the body, waits `Retry-After` seconds when that's a positive number (else 250 ms × 2^attempt), capped at 10 s, and goes round again. Anything else throws a `WorkspaceWriteError` with Graph's code and message when the body has them.

## Why it works

- **A side effect needs its own guard.** The log's guards (the version, the step key) protect what's in Postgres. A mail is in Microsoft 365. Only the service can refuse to send it twice, and only if each attempt tells it which mail it is.
- **The key must outlive the crash.** Whatever makes the key has to give the same answer after a restart. A random id or the time is made fresh by the new process. The step id is written in Workflow's log the first time the step is called, so the re-run step reads the same one back. Outside Workflow (the queue, the in-request runner) the loop uses the call id, `agent:<run>:<callId>`, which is in Postgres for the same reason.
- **The key must be unique to the action.** A key shared by two different mails makes the second one a replay of the first: silently not sent. The step id is unique per step; a model's call id is unique only if the model makes it so.
- **The retry and the replay are the same mechanism.** A 503 inside `post`, a step retried by Workflow, a job taken back by the queue, a run resumed after the kill proof's SIGKILL: each sends the key again, and fake-workspace answers the second request with the first answer.
- **Where it stops working.** Two workflows driving one run would each have their own step ids, so their keys differ and a mail could go twice. That's the M2 review's race, and why step 3's `kickAction` never starts a second workflow while the first might be alive.

## The worked example

In process: a 15 s latency fault holds the first send; the abort stands for the killed server. The step's second attempt, with the same key, is answered 202 and makes the mail. When the held request is let go, it reaches the idempotency check, finds the key done, and is answered 202 with `Idempotent-Replayed: true`. The mailroom holds one mail, under `agent:<run>:step_01M59S7YTACRNRD7B4V4Z4QEPV`.

In Workflow: Grace's approved send dies after the mail left. Workflow runs the tool step again as attempt 2 with the same step id; the mailroom saw the key twice and kept one mail, and the log holds the send's `tool_result` once. A 503 is retried with the same key and makes one mail; Retry-After 3 waits 3,000 ms, 30 waits 10,000 ms, none waits 250 then 500 ms; a 404 ("No such user.") is not retried.
