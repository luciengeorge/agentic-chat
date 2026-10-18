---
title: The tool-call wire format
type: graded
slots:
  model/responses: responses.ts
---

# The tool-call wire format

👨‍💼 Kestrel's agent answers "What is the hotel limit for a night in London?" in two turns. In the first, gpt-6-luna doesn't answer: it asks to call `search_documents`. The app runs the search and sends the passages back, and in the second turn the model answers from them. Your client can read a call already. This step sends the result back, in the one shape OpenAI accepts.

## Terms

- A **tool** is a function the model may ask for, described by a name, a sentence and a JSON Schema for its input (`ToolSpec`).
- A **tool call** is the model asking for one: the tool's name and its **arguments**, the input as JSON text.
- A **call id** (`call_...`) names one call, so its result can say which call it answers.
- An **input item** is one entry of a request's `input` list: a text turn (`role` and `content`), a `function_call` (a call the model made), or a `function_call_output` (its result).
- **`store: false`** tells OpenAI to keep nothing after it answers. Each request has to carry the whole conversation.

## Do this

🐨 Write `toInputItems` in `playground/responses.ts`: turn our messages, with their tool calls and results, into Responses input items. Reading calls out of the stream, and sending tools in the request, are already written; the 🦉 hints list what's new.

## A worked example

Turn 1 sends 172 tokens: the instructions, the question and the tool's schema. The reply is 21 events. One `output_item.added` names the call: `call_IyXA5wBnbLEOgiPMVwEOKVJR`, `search_documents`. Fifteen argument deltas follow (`{"`, `query`, `":"`, `hotel`, ` nightly`...), then `.done` with the whole text: `{"query":"hotel nightly limit London lodging travel expenses","k":5}`. The finish says `tool-calls`.

Turn 2 has to send three items: the question, that call (arguments as the model wrote them), and a `function_call_output` with the same call id and the two passages as a string of JSON. That's 721 tokens in. Leave the call out and OpenAI answers 400: "No tool call found for function call output with call_id call_IyXA5wBnbLEOgiPMVwEOKVJR." Get it right and the model writes "The hotel limit in London is **£200 per night**."

Run the tests with `pnpm ex test 01.3`.
