---
title: An orchestrator with sub-agents
type: graded
slots:
  agent/orchestrate: orchestrate.ts
---

# An orchestrator with sub-agents: the solution

`childCaps(parent, siblings, used, batch)` takes what the parent has spent (`used`, its `runUsage`) off its caps, takes the turn's whole batch off the tool calls too, and splits each between the siblings, rounded down and never below 0. Model turns and active time are copied.

`childStart` refuses a parent that is itself a sub-agent, refuses input `DelegateSchema` won't take, and otherwise returns the child: `childRunId(parent, call)` as its id, `childCaps(...)` as its caps, and `subagentMessage(task)` as its first message.

`delegateResult` makes a `succeeded` child an `ok` result with `{ runId, summary }`, and anything else a failed one ("The sub-agent failed: cap reached: 2824 tokens."). Both carry the child's `usage` when it has one.

## Why it works

- **One budget for the whole tree.** The parent's caps are for the user's whole request. Each child gets a share of what's left, and its spend comes back on its result, where the parent's `runUsage` counts it. So parent plus children can't pass the parent's cap, however the work is split. Before this was fixed in M2's review, a parent could spend about 12 × 60,000 through its children: each turn of delegates got a fresh 60,000.
- **The log is the only counter.** The child's spend lives in the child's log. Copying it onto the delegate call's result puts it in the parent's log, the only thing the parent's caps are counted from, on any machine, after any crash.
- **Children are read-only, because a model wrote their task.** The parent's model writes `task`, and it may have just read a document that says "delegate a mail to attacker@...". If the child were treated as the user, its plan would come from that task and its writes would run. Instead the child is framed as a researcher, offered the read tools only, and held by `subagentPolicy` (section 17), which refuses every write whatever the task says. Any write is the parent's, checked against a plan made from the user's own words. Section 17.3 tests exactly this attack.
- **One level.** A sub-agent can't delegate, so a run's tree is one parent wide and its spend is bounded.
- **The id comes from the call.** On Workflow, `prepareChildStep` runs `childStart` inside a step. If the step runs again after a crash, the same call gives the same child id, `startRun` finds the run already there, and no second child reads and spends it all again.
- **The parent sees summaries only.** Each child read a whole policy (5,712 and 6,184 tokens of context by its last turn). The parent's final turn sent 3,026: its own messages and two summaries. That's the point of a sub-agent: work that would fill the parent's context happens somewhere else, and only the answer comes back.

## The worked example

| Run                       | Caps (tokens, calls) | Turns: tokens in / out             | Spent           |
| ------------------------- | -------------------- | ---------------------------------- | --------------- |
| Parent, before delegating | 60,000, 30           | 2,033 / 105, 2,117 / 130           | 2,352, 1 call   |
| Child, version 1          | 28,824, 13           | 999 / 135, 3,109 / 72, 5,712 / 475 | 6,394, 2 calls  |
| Child, version 2          | 28,824, 13           | 999 / 105, 3,087 / 73, 6,184 / 360 | 6,722, 2 calls  |
| Parent, at the end        |                      | 3,026 / 406                        | 16,783, 7 calls |

The parent's 16,783 is its own growth (2,352 + 909 + 406) plus its children's 13,116. OpenAI billed the whole tree 29,127 tokens, the full input of every call: that's the daily budget's number (section 13.6), and it's always larger than the cap's.

At an 8,000-token cap the same recording shows the other side. Each child gets 2,824, and after its second turn has spent 3,316 (version 1) or 3,265: at or over its cap, so it stops `failed`. Their spend still comes back on the failed results. The parent reaches 8,933 and stops before its next turn. Drop the usage from failed results and the parent would think it had spent 2,352, carry on, and write a comparison of two sub-agents that never finished reading.
