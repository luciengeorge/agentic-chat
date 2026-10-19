---
title: Per-run caps
type: graded
slots:
  agent/caps: caps.ts
---

# Per-run caps

👨‍💼 An agent picks its own next step, so nothing in the loop stops a model that keeps searching for a document it can't find. Every run gets caps: 12 model turns, 30 tool calls, 60,000 tokens, 10 minutes of work. A run that reaches one finishes `failed`, with the cap as the reason, before it spends more.

## Terms

- A **cap** is a per-run limit. `DEFAULT_CAPS` holds Kestrel's four.
- **Usage** is what a run has spent so far: model turns, tool calls, tokens and active time. `runUsage` counts it from the events.
- **Input tokens** are what a turn sends (instructions, the conversation, tool specs); **output tokens** are what the model writes back.
- **Active time** is time spent in the `running` status. A run that's `waiting` on an approval isn't working.
- **Compaction** (section 14) replaces old events with a summary, so a turn's input can shrink.

## Do this

🐨 In `playground/caps.ts`, write `runUsage` (count from the events) and `capReached` (the first cap a run has reached, or null). The reference `decide` calls `capReached` before every model turn and every batch of calls.

## A worked example

Grace's five turns sent 1,865, 1,949, 4,109, 6,532 and 6,750 input tokens and wrote 507. Each turn resends everything before it, so adding the inputs up (21,205) counts her message five times. What the run grew by is the last context plus the output: 6,750 + 507 = **7,257** tokens, with 5 turns and 5 tool calls.

Give her run a 10,000-token cap and it finishes. Count the old way and it would have stopped at 14,934 before her mail went. At a 7,000-token cap the right count stops it too: after four turns it has used 7,011, so when Grace approves the mail, the batch is refused and nothing is sent.

Run the tests with `pnpm ex test 13.3`.
