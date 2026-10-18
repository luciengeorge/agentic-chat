---
title: The AI SDK behind the interface
type: graded
slots:
  model/ai-sdk: ai-sdk.ts
  model/tokens: tokens.ts
---

# The AI SDK behind the interface

👨‍💼 Before Kestrel searches for "How much can I spend on a hotel in London?", it asks gpt-6-luna to rewrite the question into search queries. Search needs a list it can loop over, so the model must answer with a JSON object of a known shape. The app uses the AI SDK for this, behind the same interfaces as everything else. And before any call it should know what the call will cost.

## Terms

- The **AI SDK** (`ai`, plus `@ai-sdk/openai`) is a library that does what steps 2 and 3 did by hand, for many providers: build the request, read the stream, assemble tool calls, retry.
- **Structured output** is a reply that's one JSON object matching a schema you send. **zod** is the library our schemas are written in; the SDK turns a zod schema into **JSON Schema**, the format OpenAI reads.
- **Strict mode** makes OpenAI hold the model to the schema while it writes, so it can't produce a field that isn't there or leave out one that is.
- The **context window** is how many tokens one request may hold. **Usage** is what the provider says it billed, after the call.

## Do this

🐨 Two files this time. In `playground/ai-sdk.ts`, write `object`: one `generateText` call that returns a checked object and its usage. In `playground/tokens.ts`, write `countMessageTokens`: what one message costs before you send it. The hints in each file say how.

## A worked example

The rewriter asks for an object named `search_queries` with one field, `queries`, a list of strings. Recorded on 18 October, gpt-6-luna answered `{"queries":["London hotel accommodation spending limit per night", ...]}`: three queries, 35 tokens out, 183 in.

Count it yourself first. The instructions are 114 tokens and the question 11, plus 4 for its message: 129. But the request also carries the schema, 65 tokens of JSON in `text.format`. A count that forgets it is 54 tokens short of the bill, nearly a third.

The agent's second turn in step 3 counts closer. The question is 15 tokens, the call 21 (`search_documents` and its arguments, plus 4), the two passages 516, the instructions 29 and the tool's schema 133: 714. OpenAI billed 721.

Run the tests with `pnpm ex test 01.4`.
