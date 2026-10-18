---
title: Model primitives
---

# Model primitives

Every answer Kestrel's assistant gives comes from one call to a language model: the app sends a request over HTTP, and the model's reply streams back a few characters at a time. This section opens that call up. You'll write the pieces the app's model code is made of, by hand first, then see what the AI SDK does with the same bytes.

## Terms

- A **model provider** is the company whose model answers: OpenAI here. Each one has its own HTTP API, with its own names for everything.
- An **interface** is the shape the app's code relies on, whoever stands behind it. Ours is `ChatModel` (in `src/core/model/types.ts`): one method, `stream(request)`, that gives back **events**.
- A **stream** is a reply that arrives in pieces while the model is still writing it, so the first words show before the last ones exist.
- **Server-sent events (SSE)** are how OpenAI sends that stream: plain text over one HTTP response, one event after another, each ended by a blank line.
- A **token** is the piece of text a model reads or writes as one item. Providers count limits and bills in tokens.
- A **tool call** is the model asking the app to run a function (say, search the documents) instead of answering straight away.
- A **cassette** is a recorded call: the request body we sent and the exact bytes that came back. The tests and the lab replay four of them (`fixtures/cassettes/model/`), recorded from `gpt-6-luna` on 18 October 2026, so nothing in this section calls OpenAI or needs a key.

## The steps

1. **The provider interface.** Write the echo model, a `ChatModel` with no provider behind it, and watch the app use it unchanged.
2. **Streaming by hand.** Write the SSE reader that turns the bytes of a real reply into events, wherever the network cuts them.
3. **The tool-call wire format.** Send a tool's result back to the model in the shape OpenAI expects.
4. **The AI SDK behind the interface.** Ask the SDK for structured output (a JSON object checked against a zod schema), and count a request's tokens before you send it.

The lab, `/labs/models`, shows each recorded call: the request body, every event in the reply, what your code makes of them, and the tokens it cost.
