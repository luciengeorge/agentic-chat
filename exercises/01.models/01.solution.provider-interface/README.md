---
title: The provider interface
type: graded
slots:
  model/fake: fake.ts
---

# The provider interface: the solution

`stream` reads the prompt from the last message and asks `echoAnswer` what to say. It splits the answer into words, each with the space after it, and for each one waits `delayMs` on the request's abort signal, then yields a text delta. After the last word it yields one finish: `"stop"`, and a usage of three `undefined`s.

## Why it works

- **It keeps the interface's order.** Deltas first, one finish last. `answer()` adds up the deltas into the text and reads the finish for the reason and the usage, so a model that skipped the finish, or sent two, would leave it guessing.
- **It stops when it's told to.** `delay` throws the signal's reason as soon as the signal aborts, even if it aborted between two words. That throw leaves the loop, so no finish goes out, and the caller knows the answer is cut short instead of complete.
- **It doesn't claim a bill.** `undefined` counts mean nothing was reported, and `readUsage` says `reported: false`. A model that sent zeros would tell the cost log the call was free.
- **It streams.** One word at a time, with a wait between them, the chat page fills in the way it does for the real model, so the streaming code gets exercised offline too.

## The worked example

The recorded `gpt-6-luna` call and the echo model, given the same prompt, produce 54 and 53 text deltas, each followed by one finish. gpt-6-luna's says 598 tokens in and 113 out (53 of them reasoning, billed but never shown); the echo model's says nothing was counted. `answer()` runs either one without a change, and the echo model's two citations, `[[S1: ...]]` and `[[S2: ...]]`, check out against the sources.

Swapping one model for another touched one line, in `src/routes/api/chat/-deps.ts`. That's what the interface buys.
