---
title: An orchestrator with sub-agents
type: graded
slots:
  agent/orchestrate: orchestrate.ts
---

# An orchestrator with sub-agents

👨‍💼 Grace Adeyemi asks: "Compare what versions 1 and 2 of the travel and expenses policy say about hotels." Two policies, each read whole, would fill one run's context with both. Kestrel's agent can hand each version to a **sub-agent** instead: a child run that searches, reads its one policy and reports back a few lines. The parent reads the two reports and writes the comparison. The hard part is what a child is allowed, and what it costs.

## Terms

- An **orchestrator** is a run that splits a task into parts and hands them on. Here it's an ordinary agent run with one more tool, `delegate { task }`.
- A **sub-agent** (or **child run**) is a run with `kind: subagent` and a `parent_run_id`. It has its own event log and caps, acts as the same user, and is **read-only**: it may search, read and look people up, never send, share or remember.
- A **child workflow** is how the Workflow runner runs it: the parent's workflow starts the child's own workflow with `start()` and waits on a hook the child resumes when it ends (sections 05.5 and 15).
- The child's **spend** is its `runUsage` (section 13.3): tokens and tool calls. It comes back on the delegate call's result as `usage`, so it counts against the parent's caps.

## Do this

🐨 In `playground/orchestrate.ts`, write `childCaps` (a child's share of what the parent has left), `childStart` (what a delegate call starts, or why not) and `delegateResult` (the child's outcome as the parent's tool result).

## A worked example

Grace's request, recorded on gpt-6-luna with "hand each version to its own sub-agent" added. The parent's first two turns cost 2,352 tokens and one call (its plan), then it made two `delegate` calls in one turn. Each child got:

- tokens: (60,000 − 2,352) ÷ 2 = **28,824**;
- tool calls: (30 − 1 − 2) ÷ 2 = 13.5, so **13**.

The version 1 child searched, read the policy and reported in three turns, spending 6,394 tokens and 2 calls; version 2 spent 6,722 and 2. The parent wrote its table from the two summaries: London £180 → £200, the rest of the UK £120 → £130. Its own usage at the end is **16,783** tokens (13,116 of them its children's) and 7 calls, so it has 43,217 tokens and 23 calls left.

At an 8,000-token cap, each child gets 2,824 and stops before its third turn, having spent 3,316 and 3,265. The parent is then at 8,933 and stops too, before it writes a comparison of two failures.

Run the tests with `pnpm ex test 16.3`.
