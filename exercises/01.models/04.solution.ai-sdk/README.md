---
title: The AI SDK behind the interface
type: graded
slots:
  model/ai-sdk: ai-sdk.ts
  model/tokens: tokens.ts
---

# The AI SDK behind the interface: the solution

`object` is one `generateText` call. It passes the instructions, the messages (converted as `stream` converts them), the effort as `reasoning`, the output limit, the abort signal, and `output: Output.object({ schema, name })`. It returns `result.output`, the parsed and checked object, and `result.totalUsage` as our three counts.

`countMessageTokens` counts a message's text, each tool call's name and arguments as JSON, or a tool result's name and output as JSON, and adds 4 for the message itself.

## Why it works

- **The schema rides on the request.** `Output.object` makes the SDK send `text.format: { type: "json_schema", strict: true, name: "search_queries", schema }`. OpenAI then only lets the model write text that fits: the object can't miss `queries` or add a field. It's also why every field is required: an optional one is written `.nullable()`.
- **The reply is still checked.** A refusal, or a reply cut off by the output limit, can't match the schema. The SDK checks the text against the zod schema and throws if it doesn't fit, so the rewriter never gets half an object or a string where it wanted a list.
- **The interface hides which client it is.** `aiSdkChatModel` is a `ChatModel` and a `StructuredModel`, like the hand-written client. Fed the recording from step 2, the SDK's own OpenAI provider gives the same 55 events your parser did.
- **A local count is an estimate on purpose.** It counts what we can see: text, calls and results as JSON, tools as JSON. The provider adds framing we can't see and renders schemas its own way. So budgets count before the call, keep a margin, and record the real bill from usage after it.

## The worked example

The rewrite: 3 queries back, 183 tokens in and 35 out. Counted locally, the instructions (114) and the question (15 with its overhead) come to 129. The other 54 are mostly the schema: 65 tokens as JSON, which OpenAI renders more tightly. The agent's turn 2 counts 714 (the passages alone are 516) against 721 billed, 1% apart, because there the big parts are text we count exactly.

The lesson: count everything you send. History, tool results and schemas cost tokens on every turn, because with `store: false` every turn sends them all again.
