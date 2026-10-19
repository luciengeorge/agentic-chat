---
title: "Agents: orchestration, done"
---

# Agents: orchestration, done

Kestrel's assistant now coordinates many runs at once. The router (`routeMessage`) sends each chat message down one path with a forced tool call, fails to the path that can't write, and sends a reply to a live run into that run. The orchestrator (`childStart`, `childCaps`, `delegateResult`) hands parts of a request to read-only children, each with a share of what the parent has left, and brings their spend back into the parent's log. Automations (`dueSlot`, `dueFire`, `fireRun`) fire each slot once by naming it, start runs whose ids come from the fire, and tell those runs ids, never filenames. And `fanOut` runs a fire's agents three at a time, asking the kill switch before each one.

The thread through it: every coordination problem here was solved by a **name** or a **log**. A fire happens once because every scheduler names it by its slot. A retried step finds its child or its run because their ids come from the call or the fire. A parent's caps cover its children because their spend is written into its own log. Nothing relies on a process remembering anything. That's the answer to "how do you orchestrate agents safely?" in an interview: bound the tree with one budget, keep every child's authority below the user's, and make every start idempotent by name.

## What to notice in the lab

Run `pnpm dev`, sign in as `leo.martin@kestrelpay.example` (password `dev-password`), and open `/labs/orchestration`.

- **The recorded tree** at a 60,000-token cap: two sub-agents of 28,824 tokens and 13 calls each, spending 6,394 and 6,722. The parent has used 16,783, its children's 13,116 counted, and has 43,217 left.
- **Set the cap to 8,000.** Each child gets 2,824 and stops `failed` before its third turn; the parent, at 8,933, stops too: "cap reached: 8000 tokens".
- **Pick Leo's own run** from 14 October, "Compare what the Travel and Expenses Policy (v1) and ... v2 say about hotels". Its children got 30,000 tokens and 15 calls (the batch wasn't taken off yet), both failed on "daily token budget spent", and they spent 8,272 tokens that the parent counted as 0: the hole M2's review closed, still in the dev database.
- **With 16.3 active**, the recorded tree runs on your code. Make `delegateResult` drop the usage on a failed child and look at the 8,000 cap again: the parent no longer stops.

## What comes next

Section 17 decides which of the model's calls may run at all: the user's authority, the poisoned document, plan-then-execute, and the guardrails. Its step 3 tests the attack this section kept out of the children: a document that talks the parent into delegating a write. Section 22 moves the scheduler's loop to a Vercel cron route; the fire's key keeps it at once per slot there too.
