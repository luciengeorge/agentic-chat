---
title: The tool-call wire format
type: graded
slots:
  model/responses: responses.ts
---

# The tool-call wire format: the solution

`toInputItems` maps each message with `flatMap`, since one message can become several items. A user turn is one text item. An assistant turn is its text (left out when it's empty and the turn made calls), then one `function_call` per call: the call id, the name, and the arguments as a string. A tool result is one `function_call_output` with the same call id, and its output as a string of JSON, `{"error": "..."}` for an error.

## Why it works

- **It replays the whole exchange.** With `store: false`, OpenAI has forgotten turn 1 by the time turn 2 arrives. The `function_call` item tells the model what it asked for; the `function_call_output` tells it what came back. Without the first, the second answers nothing, and OpenAI refuses the request with a 400.
- **It pairs them by `call_id`.** That's the id meant to cross turns. The stream also gives each call an item id (`fc_...`), which only ties the argument deltas to their call inside one reply. The client keeps both, and hands you the `call_...` one.
- **It sends text, as the wire wants.** Arguments go back as the model wrote them: a string input (arguments that didn't parse) goes as it is, anything else is JSON. Outputs are JSON strings too, so the passages keep their fields.
- **An error is a result too.** `{"error": "k must be 8 or less"}` tells the model what went wrong, so it can call again with better arguments instead of the run failing.

## The worked example

Replayed, turn 1 gives one tool call, `call_IyXA5wBnbLEOgiPMVwEOKVJR`, asking `search_documents` for "hotel nightly limit London lodging travel expenses" with `k` 5, and a `tool-calls` finish: 172 tokens in, 28 out. With your `toInputItems`, turn 2's body equals, field for field, the one OpenAI accepted on 18 October: the question, the call, and the output holding both versions of the limits table. It cost 721 tokens in (the passages are most of it) and 17 out: "The hotel limit in London is **£200 per night**."

Notice what the reply didn't say: unlike the chat prompt, the agent's instructions ask for no citations, so none came back. Section 10 is where that gets enforced.
