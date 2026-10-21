---
title: Kestrel's edits stopped arriving
type: lab
---

# Kestrel's edits stopped arriving: the solution

**The cause: a poison message, and a relay that never gives up on it.** The poison is an outbox row asking for a Kestrel sync with the payload `{"Mode": "delta"}` (a capital M), written two hours ago. `SyncPayload` in `src/server/plugins/relay-deliver.ts` was changed to accept upper-case modes, and now calls `.toLowerCase()` on `payload.mode`, which is `undefined` here: a `TypeError`. That's an ordinary error, not `UndeliverableError`, so the relay counts it as worth retrying. The fault: in `deliverRow` (`src/core/queue/outbox.ts`) the failure update no longer writes `attempts`, so the count stays 0 and the row never reaches the limit of 5 that would mark it failed. The relay delivers a partition oldest first and stops at its first failure (section 05, step 4: that's what keeps a tenant's syncs in order). So every Kestrel sync queues behind the poison, forever. Harbour's partition is a different one, and moves.

## The path a good debugger takes

1. **Split the path.** fake-workspace delivered the notifications, so the webhook reached the app; Harbour's edits arrive, so the relay, the workflows and the database work. What's left is Kestrel's share of the queue.
2. **The queue board** (`/labs/background`, as a Kestrel user) shows an outbox row two hours old, `attempts 0`, with a `last_error` rewritten on every pass, and newer sync requests waiting behind it. The edits did arrive as rows; they're stuck in line.
3. **The log** shows a `relay pass` every couple of seconds with the same id under `retried`, never under `failed`. So the relay is running and trying, and something stops it from giving up.
4. **The row itself.** `SELECT id, attempts, last_error, created_at FROM outbox WHERE published_at IS NULL AND failed_at IS NULL` gives a row with an error but no attempts counted. An error with 0 attempts is a contradiction, which points at the code that writes both.
5. **Where are attempts counted, and what marks a row failed?** The failure branch of `deliverRow`: it computes `attempts`, decides `failed`, and its update writes `lastError` and `failedAt`, but not `attempts`. And `last_error` (`TypeError: Cannot read properties of undefined (reading 'toLowerCase')`) leads to `SyncPayload`.

## The fix

Put `attempts` back in the failure update, so the poison is marked failed after 5 tries and the partition moves on. Make `SyncPayload` check before it reads, as it did, so a malformed payload is `UndeliverableError`, failed at once and never retried:

```ts
const SyncPayload = (payload: unknown) =>
  typeof payload === "object" && payload !== null && ["full", "delta"].includes((payload as { mode?: string }).mode!)
    ? (payload as { mode: "full" | "delta" })
    : null;
```

Restart `pnpm dev` (the relay is a server plugin, which doesn't hot-reload). Within a few passes the poison is failed and the waiting syncs go out. The check needs the dev server's relay running: it looks for any Kestrel sync request older than a minute that's neither published nor failed, then runs the fault's test, which plays a poison row through the relay and checks it ends failed with its attempts counted, and that the row behind it is delivered.

## The lesson

- **Every retry loop needs a count that's written, and a limit.** Without one, a message that can never succeed (a poison message) is retried forever, and in an ordered queue it blocks everything behind it. The usual end is a dead-letter state (here `failed_at`) that a person looks at.
- **Errors that can't succeed shouldn't be retried.** A malformed payload won't parse better the fifth time. Telling "bad input" (fail at once) from "the world is down" (retry) is the job of `UndeliverableError` and `OutageError`.
- **Alert on age, not on errors.** Nothing errored loudly here. The oldest unpublished row's age per partition is the number that would have paged someone two hours earlier.
