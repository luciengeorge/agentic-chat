---
title: Daily budgets and the kill switch
type: graded
slots:
  agent/budget: budget.ts
---

# Daily budgets and the kill switch: the solution

`holdBudget` is one upsert. The `INSERT ... SELECT` makes the day's row holding this hold, when `dailyTokens` covers it (or when a row exists, so the insert reaches the conflict). `ON CONFLICT ... DO UPDATE` keeps the row's live holds, adds this one, and runs only `WHERE token_limit - tokens_used - held >= tokens`. `RETURNING 1` says whether anything was written: a row back is the hold, none is a refusal.

`createRunGuard` returns three checks. `beforeModelTurn(estimate = 1)` runs in one tenant transaction: the kill switch (`killedEverywhere`, then `switchedOff`), then `holdBudget` for `ceil(estimate)` on today's row, throwing `RunHalted("daily token budget spent")` when it's refused. `afterModelTurn(usage, hold)` settles on the hold's day with input plus output (0 for a failed call). `beforeToolCall` is the kill switch alone.

## Why it works

- **One statement, one lock.** The upsert locks the day's row. A second turn's upsert waits for it, then reads the row as the first left it, holds included, so nothing can come between the check and the hold. Five turns at once against room for two: two holds, three refusals.
- **Hold, then settle.** A call's cost is only known after it. Holding the most it can cost keeps every turn in flight inside the limit together; settling gives back what it didn't use.
- **Holds lapse.** A process killed mid-call never settles. Its hold stops counting after five minutes, longer than any model call, so a crash can't lock a user out until midnight.
- **The switch runs before tool calls too.** A run halfway through a turn's calls stops at the next call, not after its mail is sent.
- **`RunHalted` passes the model by.** `executeCall` throws it on, and the runner fails the run with the reason.

## The worked example

Grace's planning turn: `turnEstimate` is 2,033 for the request plus 4,000 for the answer, so the row holds 6,033 while the call runs. Settled, the row shows `tokens_used` 1,970 and no holds. A day of 500,000 covers 23 runs like hers (21,712 each). The 24th is refused at its first hold, with 624 tokens left against 6,033, instead of being found over the limit afterwards.
