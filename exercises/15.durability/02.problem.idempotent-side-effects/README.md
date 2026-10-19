---
title: Idempotent side effects
type: graded
slots:
  agent/durable: durable.ts
  agent/tools/workspace: workspace.ts
---

# Idempotent side effects

👨‍💼 Step 1 kept the log right: a redone step writes nothing twice. A mail isn't in the log, though. It leaves for Kestrel's Microsoft 365 (fake-workspace here), and if the server dies after the request left and before the answer came back, the run has no record of it and sends again. Tom must still get one mail.

## Terms

- An action is **idempotent** when doing it twice has the effect of doing it once.
- An **idempotency key** is a name for one action that the caller sends with every attempt of it, in the `Idempotency-Key` header. fake-workspace keeps the answer it gave each key: the same key and the same request get that answer again (with `Idempotent-Replayed: true`) and nothing is sent; the same key with a different request gets a 422.
- Inside Workflow, a **step id** (`step_01M59S7Y...`) is the id Workflow gives a step the first time the body calls it. A retry of the step, or a re-run after a crash, keeps it.
- **`Retry-After`** is a header a busy service sends with a 429 or a 503: the seconds to wait before asking again.

## Do this

🐨 In `playground/durable.ts`, write `stepIdempotencyKey`, the key a Workflow step's write sends, and `withIdempotencyKey`, which hands that key to the tools in place of the loop's own.

🐨 In `playground/workspace.ts`, write `post`: the one request both writes (`sendMail`, `invite`) make, with the key, retried on a 429 or a 5xx.

🚨 The classic mistake is a key that changes between attempts: a random id, the time, the attempt number. The second attempt is then a new request to the service, and a new mail.

## A worked example

The kill proof, in miniature, against fake-workspace in process. A latency fault holds Grace's send for 15 seconds, as `pnpm agent:kill-proof` does. The server running the step is killed while it waits (an abort): the request has left, and its answer is lost. The step runs again after the restart, with the key it had, `agent:<run>:step_01M59S7Y...`, and goes straight through: 202, one mail. Then the held request finishes inside fake-workspace, finds its key already done, and answers 202 with `Idempotent-Replayed: true`. One mail.

In Workflow itself: Grace's run, approved, with the send's step made to die just after the mail left. Workflow runs it again (attempt 2, about a second later) with the same step id, so the same key: two sends, one mail.

Run the tests with `pnpm ex test 15.2`. They need Postgres (`pnpm ex up`).
