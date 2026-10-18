---
title: Background work
---

# Background work

Ingesting a document takes seconds; the 3,000-page filing takes minutes. None of that can happen inside the web request that noticed the change. It happens in the background: something records that the work is owed, something else picks it up, and if a server dies halfway, the work is picked up again and finished. This section builds that machinery, first by hand on Postgres, then on Vercel Workflow.

## Terms

- A **job** is one piece of background work, saved in the database so it survives a crash. A **queue** is the list of jobs waiting, and a **worker** is a loop that takes them one at a time.
- A **workflow** is a function whose progress is saved after each **step**, so a crash resumes where it stopped. A **run** is one execution of it. Workflow retries a step that throws.
- **At least once** means a piece of work may run twice (after a crash, or a message delivered twice), never zero times. So the work must be **idempotent**: doing it twice has the same effect as doing it once.
- **Fan-out** splits one big job into many small ones that run side by side.
- **Starvation** is work that never gets a turn, because other work keeps every worker busy.

## The steps

All six work in `src/core/queue/`, which the app imports as `#learn/queue/<file>`.

1. **A job queue by hand** (`queue.ts`). Claim jobs so no two workers take the same one, a crash gives the job back, and a poison job ends up dead.
2. **Retries** (`retry.ts`). Tell Workflow which failures to retry, when, and which to stop on.
3. **The outbox and relay** (`outbox.ts`). Start a workflow for every write that asks for one, exactly when the write commits.
4. **One relay per partition, and outages** (`outbox.ts`). Keep two relays from delivering one document's rows out of order, and keep an outage from using up every row's attempts.
5. **Fan-out over the filing** (`fanout.ts`). Cut the 3,000-page filing into page ranges and run them as child workflows, ten at a time.
6. **Per-class limits** (`queue.ts`). Keep a backfill from starving the small, urgent work behind it.

The lab, `/labs/background`, is a queue board: jobs by class and state, the outbox, and a link to Workflow's run viewer. Run the starvation demo there while you do step 6.
