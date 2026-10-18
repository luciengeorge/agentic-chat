---
title: 429 and Retry-After
type: graded
slots:
  connectors/graph: graph.ts
---

# 429 and Retry-After: the solution

`retryDelay` returns `null` unless the status is 429 or 503 and `attempt` is still below `maxRetries`. Otherwise it returns what `Retry-After` says (`retryAfterMs`), or, when it says nothing, `500 * 2 ** attempt` capped at 30,000.

## Why it works

- **It retries only what time can fix.** Throttling and a busy server pass; a wrong token, a missing permission or a missing item don't. Retrying those only adds waits before the same error, and hides it from whoever has to fix it.
- **It does as it's told.** SharePoint knows when it will take you back. Waiting exactly that long gets you in on the next try; retrying sooner earns another 429, and SharePoint blocks clients that keep ignoring it.
- **Without a hint, it backs off.** Doubling tries quickly while the trouble might be a blip, then spaces the tries out, so a sick server gets fewer and fewer requests. The cap stops one wait from becoming minutes.
- **It knows when to stop.** After `maxRetries` the error goes up, still `retryable` and still carrying `retryAfterMs`. One request shouldn't sleep for an hour inside a sync; the sync step fails, and the workflow (section 05) schedules it again when the source said.
- **Why `??`.** `Retry-After: 0` means "now". `||` would treat 0 as missing and wait 500 ms for nothing.

## The worked example

Two 429s with `Retry-After: 3`, after the sixth request of a `$top=5` crawl: statuses 200 ×6, 429, 429, then 200s; waits `[3000, 3000]`; 22 requests; 40 files. A 503 with no header three times: waits `[500, 1000, 2000]`. At attempt 5 the doubling gives 16,000 ms; at 6 it would be 32,000, so the cap gives 30,000.

`send` also cancels each refused answer's body before it sleeps. An unread body keeps its connection open, and a client retrying through a long throttle would otherwise run out of them.
