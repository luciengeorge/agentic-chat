---
title: Daily budgets and the kill switch
type: graded
slots:
  agent/budget: budget.ts
---

# Daily budgets and the kill switch

👨‍💼 Caps stop one run. They don't stop a user starting forty, or a bug that starts runs in a loop. Every user gets 500,000 model tokens a day, and every tenant has a kill switch that stops its agents at once. Both live in Postgres, so every runner on every server sees the same numbers.

## Terms

- The **daily budget** is a row in `agent_budgets` per user per UTC day: `token_limit`, `tokens_used`, and `holds`.
- A **hold** reserves a call's tokens before it runs: `{ "<id>": { tokens, until } }`. **Settling** it adds what the call used and drops the hold. A hold **lapses** at `until`, five minutes after it was taken.
- An **estimate** (`turnEstimate`) is the most a call can cost: its request's tokens plus its longest answer (4,000 when unset).
- An **upsert** is an insert that updates the row instead when one already exists (`ON CONFLICT ... DO UPDATE`). It locks the row it touches.
- The **kill switch** is `agent_switches` (`enabled = false` with a reason) for one tenant, or `AGENT_KILL_SWITCH=1` for everyone.

## Do this

🐨 In `playground/budget.ts`, write `holdBudget` (one statement that holds a call's tokens or refuses) and `createRunGuard` (the kill switch before every model turn and tool call, a hold before each model turn, a settle after). `modelTurn` and `runTool` call your guard.

## A worked example

Grace's planning turn sends 2,033 tokens by our count (the instructions, her message, the six tool specs) with no output limit set, so it holds 6,033 while it runs. It comes back having used 1,865 in and 105 out, and settles at 1,970: the other 4,063 are free again. Her whole run bills 21,712, so 500,000 a day is about 23 runs like it.

Before holds, the guard checked "is anything left?" and charged after the call. On 14 October leo.martin's day ended at 507,000 of 500,000: each turn in flight saw the same room left.

Run the tests with `pnpm ex test 13.6`. They need Postgres (`pnpm ex up`).
