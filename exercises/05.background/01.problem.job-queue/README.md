---
title: A job queue by hand
type: graded
slots:
  queue/queue: queue.ts
---

# A job queue by hand

👨‍💼 Kestrel's agent runs (section 15) don't run inside the request that asked for them. They wait in a queue, and a couple of workers in the server take them one at a time. Two workers take the same run, and it books a payment twice. A worker crashes holding a run, and it never finishes. One run fails every time, and it's retried every second forever. All three come down to one function: how a worker claims a job.

## Terms

- A **job** is one row in the `jobs` table: a piece of work, its `state` (`queued`, `running`, `done` or `dead`) and how many `attempts` it has had.
- A **worker** is a loop that claims a job, does it, and marks it done (or failed).
- A **lock** on a row stops other transactions from changing it until yours ends. `FOR UPDATE` takes one; `SKIP LOCKED` passes over rows that someone else holds.
- A **lease** is how long a worker may hold a job without checking in (`locked_until`). A **heartbeat** renews it.
- A **poison job** fails every time it runs. **Backoff** is waiting longer before each retry.

## Do this

🐨 Write `claim` in `playground/queue.ts`: in one SQL statement, pick the oldest due job that nobody holds, mark it running under a lease, and count the attempt. Everything around it is written: `enqueue`, `heartbeat`, `complete`, `fail` (which sends a job `dead` once it's used its attempts) and `reclaimExpired`, and the worker loop in `worker.ts`.

## A worked example

A poison job, with the worker's default backoff of `min(60 s, 1 s × 2^(attempts − 1))` and 5 attempts:

| Attempt (counted by `claim`) | Fails, then waits |
| ---------------------------- | ----------------- |
| 1                            | 1 s               |
| 2                            | 2 s               |
| 3                            | 4 s               |
| 4                            | 8 s               |
| 5                            | goes `dead`       |

That's 15 seconds of waiting, then the queue is clear. With a 30-second lease and a heartbeat every 10 seconds, a crashed worker's job is back on the queue at most 30 seconds after the crash, as attempt 2.

Run the tests with `pnpm ex test 05.1`. They need Postgres (`pnpm ex up`).
