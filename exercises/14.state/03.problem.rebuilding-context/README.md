---
title: Rebuilding context from events
type: graded
slots:
  agent/context: context.ts
---

# Rebuilding context from events

👨‍💼 A model has no memory. Each turn of Leo's email run, the runner sends the whole story again: Leo's message, every call the agent made, every result. Leo's run waits a day for his approval, and the server it started on has restarted twice since. When it resumes, the only thing left is the log, so the story is rebuilt from the log, every turn, and it has to fit the model.

## Terms

- The **context** is `{ instructions, messages }`: what one model turn is sent. The messages are user turns, assistant turns (with any **tool calls**), and **tool results**, each naming the call it answers.
- A **group** is one turn as the model must see it: a user message alone, or an assistant turn followed by the results of its calls.
- The **budget** is how many tokens of messages the context may hold (24,000 by default).
- A **compaction** event (step 6 writes them) says: everything up to `throughSeq` is summed up in this `summary`.
- The **planning view** is what the turn that writes the plan (section 17) sees: the base instructions and the user's own messages, nothing else.

## Do this

🐨 In `playground/context.ts`, write `eventGroups`, which folds events into groups, and `buildContext`, which picks the groups that fit the budget, starting from the latest compaction. The pieces around them are written: `latestCompaction`, `summaryMessage`, `notesBlock` (the user's notes, framed as data) and `userMessages` (the planning view's messages).

🚨 The classic mistake is splitting a turn: keeping a tool result whose call was dropped (by the budget or by a compaction), or keeping an old small turn after dropping a newer big one. The first makes the model API refuse the request; the second shows the model a conversation that never happened.

## A worked example

Leo's run, all 17 events, folds into 6 groups: his message (27 tokens), the plan (108), the search with Tom's directory entry (2,121), the contract read (2,399), the approved mail (201) and the closing turn (27). That's 11 messages and 4,883 tokens.

At a budget of 4,000, keep groups from the newest back: 27, then 201 (228), then 2,399 (2,627). The search would make 4,748, so it goes, and so does everything older, even the 27-token message that would fit. The context is 5 messages, 2,627 tokens, starting with the `read_document` call.

The `lost-plan` run, at seq 16, is 15 messages and 15,675 tokens. Its seq 17 is a compaction through seq 12. After it, the context is the summary plus seq 13 to 16: 5 messages, 5,630 tokens.

Run the tests with `pnpm ex test 14.3`.
