---
title: Tool calls by hand
type: graded
slots:
  agent/loop: loop.ts
---

# Tool calls by hand: the solution

`readTurn` loops over the stream with `for await`. A `text-delta` is appended to the text and handed to `onTextDelta`; a `tool-call` becomes `{ callId, tool: name, input }`; the `finish` gives the usage. No finish, no turn: it throws.

`decide` waits on a run whose latest status is final. It finds the last `assistant_turn` and the events after it. With no turn yet, a user message means `model`. Otherwise `pendingCalls` sorts the turn's unanswered calls: anything runnable goes out as one `tools` action, then the first call needing approval as `approval`, then `wait` while the user decides. With nothing left, a turn that made calls (all answered now) or a newer user message means `model`, and a turn of words alone means `finish`.

## Why it works

- **The model never runs anything.** A tool call is text the model wrote; the app chooses to act on it. That's why every write can wait for approval, and why section 17 can refuse a call the model wanted.
- **The log is the whole state.** `decide` takes the events and nothing else, so any runner can stop and pick the run up again, in another process, a day later. That's what sections 14 and 15 build on.
- **Results go back before the end.** A turn's calls are the model saying "I need this first". Once the results are in, the model must read them, so the next action is `model`. Only a turn with no calls ends the run.
- **Only the events after the last turn matter.** The model has seen everything before its last turn; what came after is what it hasn't answered yet.

## The worked example

Grace's run, decision by decision (the seq is the event `decide` had just seen):

| After                | Decision            |
| -------------------- | ------------------- |
| 1, her message       | `model`             |
| 2, the plan          | `tools` (make_plan) |
| 3, its result        | `model`             |
| 4, search and find   | `tools` (both)      |
| 6, both results      | `model`             |
| 7, read the MSA      | `tools`             |
| 8, its result        | `model`             |
| 9, mail Tom          | `approval`          |
| 10, asked            | `wait`              |
| 11, approved         | `tools` (send_mail) |
| 12, sent             | `model`             |
| 13, "Emailed Tom..." | `finish`            |

Five turns sent 1,865, 1,949, 4,109, 6,532 and 6,750 input tokens: each turn sends the whole conversation again, plus what the last calls returned. Turn four is 2,423 tokens bigger than turn three, almost all of it the MSA's text.
