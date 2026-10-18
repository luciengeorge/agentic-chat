---
title: Streaming with the AI SDK
type: graded
slots:
  generate/stream: stream.ts
---

# Streaming with the AI SDK: the solution

`writeAnswer` loops over the events with `for await`. A `sources` event is kept in `streamed.sources` and written as one `data-sources` part of `sourceRef`s. A `text-delta` writes `text-start` the first time (a flag remembers), then a `text-delta` with id `text`, and adds the delta to `streamed.text`. `done` keeps the result, writes `text-end` if the flag is set, then `data-verdict` with `verdictOf(result)`.

## Why it works

- **It writes as it reads.** Each `writer.write` goes onto the response the moment it's called, and `answer()` yields each delta the moment the model sends it, so the words reach Leo's screen while gpt-6-luna is still writing.
- **One text part.** `useChat` appends every `text-delta` with the same id to the part `text-start` opened. A `text-start` per delta would give 61 one-word paragraphs, each its own part.
- **Data parts arrive whole.** The sources go first, so the page can list them before any words; the verdict goes last, when the citations are known, and the chips appear.
- **The chunk text stays on the server.** The browser draws a chip from a `SourceRef`; the text, up to eight chunks of 512 tokens, is only needed by the validator. A chip opens its chunk through `getCitedChunk`, which checks access again.
- **A stop leaves a record.** `streamed` is the route's copy of what went out. When the model call throws because Leo left, the route stores `streamed.text` with status `aborted`.

## The worked example

The London reply: 8 `SourceRef`s (S1 is version 1, S3 version 2's "what changed" table), 61 deltas, and a verdict with two citations of S3. `readUIMessageStream`, what `useChat` runs, turns them into one message: `data-sources`, `text`, `data-verdict`.

Notice the model got the conflict right with version 1 ranked first: the instructions say to prefer the newer version and say the old one differs, and S3 states both limits in one row.
