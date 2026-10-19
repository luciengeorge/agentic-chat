---
title: Compaction and memory
type: graded
slots:
  agent/compact: compact.ts
  agent/memory: memory.ts
---

# Compaction and memory

👨‍💼 On 14 October Tom ran "email Daniel Reyes a two-line summary of the INC-2026-0817 postmortem". The run searched four times, read a report, and passed 16,000 tokens, so it compacted: the model summarised seq 1 to 12. Its summary listed the plan as one call among many. On the next turn the model planned again (seq 18), the policy refused it (seq 19: a new plan needs a new message from the user), and the run ended "I wasn't able to proceed with the email because the plan for that write was refused." The mail Tom asked for never went. That run is `lost-plan`, and this step is the fix.

## Terms

- The **threshold** is when to compact: past 16,000 tokens of **live** events (those after the latest compaction). The newest 4,000 tokens always stay as they are.
- A **closed point** is a seq at which every call made so far has its answer: a result, or an approval that was refused or expired.
- The **plan** is the `make_plan` call the model makes in the first turn after the user's message (section 17 checks every write against it). It's **in force** for that message until the user sends another.
- The **kept facts** are lines code adds to the model's summary: the plan in force, open approvals, decisions, every call. Code writes them, so the model can't drop or change them.
- A **memory note** is a short fact a user asked the agent to keep (the `remember` tool), loaded into every later run. A user has at most 20, of at most 280 characters.

## Do this

🐨 In `playground/compact.ts`, write `compactionPoint` (where to cut) and `planInForce` (the plan line, from the log). `compact`, which asks the model for the story and appends `keptFacts`, is written. In `playground/memory.ts`, write `addNote`; `listNotes`, `deleteNote` and the `remember` tool are written.

🚨 The classic mistake is rebuilding from the summary and losing the plan: looking for it in the context the model sees (the live events) rather than the whole log, so it vanishes after the first compaction. For notes, it's making room: dropping the oldest note when memory is full, which lets a poisoned document wipe what the user said.

## A worked example

At seq 16 the lost-plan run has 16,285 tokens of live events: past 16,000. Seq 13 is a `read_document` call whose result is seq 14, so 13 isn't closed; after 14, only 3,575 tokens would stay, under 4,000. The cut is seq 12. Your `planInForce` on the log gives:

`Plan in force for user message smoke-c600f552 (call call_4OPecZV5y1VLYzaMC6mmEfYO; it's already made, so don't call make_plan again): [{"tool":"send_mail","targets":["Daniel Reyes (daniel.reyes@kestrelpay.example)"],"documents":[]}]`

With the model's real summary and your kept facts, the context drops from 15,675 tokens to 5,700. The summary that lost the plan made 5,630: keeping it costs 70 tokens. On `two-compactions`, the second cut (seq 18) still finds the plan made at seq 3, inside what the first summary covered.

Daniel's real note, from the same day's live scenarios: "I prefer answers as short bullet points." Stored once, whatever its spacing or case; the 21st note is refused.

Run the tests with `pnpm ex test 14.6`. The memory tests need Postgres (`pnpm ex up`).
