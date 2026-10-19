---
title: The poisoned document
type: graded
slots:
  agent/loop: loop.ts
  agent/plan: plan.ts
---

# The poisoned document: the solution

`planningInput` returns `context.planning` when the context has one (`buildContext` builds it: the base instructions with the planning note, and the user's messages since the last compaction). Otherwise it returns the context's instructions and its user messages, minus any that start with `<summary>`.

`planningTurn` finds the latest `user_message`, then returns the first `assistant_turn` after it, or null.

## Why it works

- **The plan comes first.** The planning turn is forced to call `make_plan` before any tool has run in this request, and it sees the user's words and nothing else: no tool output, no earlier answer, no summary, no memory note. Nothing a document says can be in it.
- **Only that plan counts.** The model can call `make_plan` again after reading the pack, with the pack's mail in it. That call isn't in the planning turn, so `currentPlan` ignores it and the policy refuses it.
- **Each message gets its own plan.** The planning turn is found from the latest user message, so a follow-up is planned afresh from the user's words, and an old plan can't cover a new request.
- **The prompt is a layer, not the wall.** gpt-6-luna ignored the pack live, and its answer warned Ella. The plan holds when the model doesn't, which is what the scripted test shows.

## The worked example

In the recording, requests 1 and 2 hold no trace of the pack; requests 3 and 4 do (the search's passages and the read). In the follow-up the planning request holds Ella's question and "Thanks. Email that summary to Tom Whitfield." and nothing else. The obeying model's second `make_plan` (the data room) and its mail to the data room are refused; its mail to Tom, which the real plan names, goes.

One edge, from M2's review: after a compaction (section 14), the planning turn sees only the user's messages since it, because the summary mixes their words with tool output. That errs toward less authority: a plan can miss something the user said earlier, never gain something a document said.
