---
title: The provider interface
type: graded
slots:
  model/fake: fake.ts
---

# The provider interface

👨‍💼 Ana joins Kestrel's platform team on a Monday. Her OpenAI key won't arrive until Wednesday, but she wants to run the app today and ask it "What is the hotel limit for a night in London?". Nothing in the app imports OpenAI: the chat route, the answer pipeline and the agent all talk to a `ChatModel`. So a model with no provider behind it can stand in, as long as it keeps the interface's promises.

## Terms

- **`ChatModel`** is the interface: an `id` and one method, `stream(request)`. The request holds the instructions, the messages and the reasoning effort; the method gives back events as they happen.
- A **text-delta** event carries the next few characters of the answer. A **finish** event ends the stream: why it ended (`finishReason`) and what was billed (`usage`).
- An **abort signal** (`request.abortSignal`) lets the caller say "stop": the user closed the tab, or the agent ran out of budget.
- An **async generator** (`async *stream()`) is a function that can `await` and `yield`: each `yield` hands one event to whoever is reading.

## Do this

🐨 Open `playground/fake.ts` and write `stream` for the echo model: stream `echoAnswer(prompt)` a word at a time, then one finish. The hints in the file say how. `echoAnswer` (which sources to quote) and `delay` are already written.

## A worked example

The tests replay a real call: the chat prompt for Ana's question, with two sources (versions 2 and 1 of the expenses policy), sent to `gpt-6-luna`. Its reply streamed as 54 text deltas, "The London hotel limit is **£200 a night**..." in pieces, then one finish: 598 tokens in, 113 out, 53 of those spent reasoning.

Your echo model gets the same prompt. It answers with the first sentence of each source, cited: 53 words, so 53 deltas, then one finish with no usage. Same shape, so the app can't tell them apart. Only the finish says one was billed and the other wasn't.

Run the tests with `pnpm ex test 01.1`.
