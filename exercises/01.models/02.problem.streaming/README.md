---
title: Streaming by hand
type: graded
slots:
  model/responses: responses.ts
---

# Streaming by hand

👨‍💼 Kestrel's chat page shows the first words of an answer within a second, though gpt-6-luna takes several to finish it. That works because the reply arrives as a stream, and the app reads it as it comes. Today the AI SDK does that reading. This step does it by hand, so you know what the SDK is doing when it breaks.

## Terms

- An **HTTP body** can arrive in many **reads**: each `reader.read()` hands over however many bytes the network had ready, from one to thousands.
- **Server-sent events (SSE)** are lines of text. `event: <name>` names an event, each `data: <text>` line adds to its data, a line starting with `:` is a comment, and a **blank line** ends the event. OpenAI's data is one JSON object per event.
- **UTF-8** is how text becomes bytes. Plain letters take one byte each; "£" takes two (C2 A3), "€" three.
- **CRLF** is a line ending written as two characters, carriage return (`\r`) then line feed (`\n`). SSE allows it as well as a plain `\n`.

## Do this

🐨 Write `parseSse` in `playground/responses.ts`: turn a body's bytes into events, one per blank-line-ended block. `parseBlock` (one block's fields) is written, and so is the rest of the client that uses your events.

## A worked example

The recorded answer is 28,955 bytes holding 64 events: `response.created`, 54 text deltas, a few bookkeeping events, then `response.completed` with the bill. Read 1,024 bytes at a time, that's 29 reads, and 21 of the 64 events are cut across two of them.

The 13th event is the delta "£". Its two bytes sit at offsets 10,272 and 10,273. Cut the reads between them and a decoder that starts afresh on each read sees C2 alone, then A3 alone, and writes "��". Your reader has to hand back "£".

Put together, the 54 deltas read "The London hotel limit is **£200 a night** under v2...", and the last event says 598 tokens in and 113 out.

Run the tests with `pnpm ex test 01.2`.
