---
title: Model primitives, done
---

# Model primitives, done

You've written each layer of a model call. The echo model showed what the interface asks of any model: text deltas, then one finish, a throw when it's stopped, and no bill it didn't run up. Your SSE reader turned 28,955 recorded bytes into 64 events, wherever the reads cut them, "£" included. Your `toInputItems` replayed a tool call so exactly that the second request matches, field for field, the one OpenAI accepted. And the AI SDK, behind the same interfaces, gave back a checked object, with a count you could compare against its bill.

## What to notice in the lab

Open `/labs/models` (any user can see it). It replays the four recordings through `#learn/model/*`, so it shows your code while a step of this section is active.

- **answer**: the request body on the left, all 64 events on the right. Scroll to event 13, the delta "£", and to the last, `response.completed`, with 598 tokens in, 113 out, 53 of them reasoning. Set the read size to 7 bytes: the events don't change, because your reader waits for each blank line.
- **tool-call-1 and tool-call-2**: the call arrives as one `output_item.added` and fifteen argument deltas. In turn 2's body, find the `function_call` and the `function_call_output` with the same `call_id`.
- **rewrite**: one JSON reply, no stream. Compare "counted" (129) with "billed" (183): the gap is the schema in `text.format`.

## What comes next

The app already runs on the AI SDK; you won't need the hand-written client again. What carries on is the interface. Section 06 puts the embedding model behind one too, section 10 builds the prompt you've been replaying here, and section 13 writes the agent loop that sends `toInputItems`' output turn after turn, counting tokens as it goes. First, section 02 fetches the documents those prompts quote from.
