---
title: A token bucket in Postgres
type: graded
slots:
  boundary/rate-limit: rate-limit.ts
---

# A token bucket in Postgres: the solution

`takeToken` inserts the row full (`ON CONFLICT ... DO NOTHING`), then runs one UPDATE. `available` is `LEAST(capacity, tokens + GREATEST(0, seconds since refilled_at) * refillPerSecond)`; `tokens` becomes `available - cost` when `available >= cost`, else `available`; `refilled_at` becomes `GREATEST(refilled_at, now)`. `RETURNING new.tokens, <available from old> >= cost` says what happened, and `bucketResult` turns that into the answer: `remaining` is the floor of the new tokens, and a refusal's `retryAfterSeconds` is `ceil((cost - tokens) / refillPerSecond)`, the tokens still missing divided by the rate they come back at.

## Why it works

- **The clock does the refilling.** The row stores tokens and when they were counted. Each request works out the refill since then, so an idle bucket costs nothing and needs no timer.
- **One UPDATE is one decision.** Postgres locks the row for the UPDATE; a concurrent one waits, then re-reads the row the first left behind. Twelve at once take turns, and only three find a token. A SELECT followed by an UPDATE decides on a value that may already be gone.
- **Every request banks the refill.** A refusal stores what was available and moves `refilled_at` on, so those seconds are counted once.
- **Time only goes forward.** `GREATEST(0, ...)` refills nothing for a clock that's behind, and `GREATEST(refilled_at, now)` never moves the stamp back.
- **It lives where every server looks.** Several app servers share the one row, inside the tenant's transaction, behind RLS like every tenant table.

## The worked example

Leo's ten at 09:00:00 leave 9 to 0; the 11th gets Retry-After 6; at 09:00:03, 3; at 09:00:06, allowed; at 09:01:06, allowed with 9 left and the row reading 9 tokens refilled at 09:01:06. Twelve concurrent requests against 3 tokens: 3 allowed.

A signed-in user the directory hasn't synced has no principal, and the bucket row's foreign key to `principals` refuses the insert: `handleChat` answers that 403 `not_in_directory`.
