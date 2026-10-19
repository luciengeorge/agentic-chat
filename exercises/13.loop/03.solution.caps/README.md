---
title: Per-run caps
type: graded
slots:
  agent/caps: caps.ts
---

# Per-run caps: the solution

`runUsage` walks the events once. An `assistant_turn` adds a model turn, its output, and `max(0, input - previous input)`. A `tool_result` adds a tool call, plus a sub-agent's `usage` if it carries one. A `status` event closes the open running span and opens a new one if the run moved to `running`; the last open span runs to the latest event, and a log with no status counts from its first event.

`capReached(usage, caps, toolCalls = 0)` checks, in order: active time, tokens, then model turns (only before a turn, when `toolCalls` is 0), then tool calls (only before a batch, as `used + toolCalls > cap`).

## Why it works

- **It counts growth, not resends.** Every turn sends the whole context again. Charging the full input each time would count the first message once per turn, and a run would hit 60,000 after three to five turns however small compaction kept its context. Counting only what each turn adds means a compacted context (smaller than the last one) adds nothing.
- **It counts from the log.** A run resumed on another machine has nothing but its events, and gets the same numbers.
- **It checks before.** A batch of five calls at 28 of 30 is refused before any of them runs. A check after would find out at 33.
- **Waiting is free.** A run waiting days for an approval spends nothing, so only `running` spans count toward the 10 minutes.

## The worked example

Grace's run: 5 turns, 5 results, 7,257 tokens, and 13 seconds of active time on the replay's clock (one event a second). The token count is 6,750 (her last context) plus 507 output. The daily budget (step 6) still charges 21,712, the full input and output of every call, because that's what OpenAI bills; the cap is about how much a run grows.

At a 7,000-token cap, `decide` sees 7,011 when the approved `send_mail` is about to run and finishes the run: `cap reached: 7000 tokens`, nothing sent.
