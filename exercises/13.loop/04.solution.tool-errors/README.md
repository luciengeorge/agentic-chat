---
title: Errors fed back to the model
type: graded
slots:
  agent/loop: loop.ts
---

# Errors fed back to the model: the solution

`giveUp(since)` takes the `error` events after the last turn. A non-retryable one finishes the run `failed` with its message; `MAX_RETRIES` (3) retryable ones finish it with `gave up after 3 errors: <last message>`; fewer, and it returns null.

`executeCall` builds the call's context (the viewer, the run, the call, the key `agent:<run>:<call>`, and a signal that fires on the run's abort or the timeout), then races `tool.execute` against a promise that rejects when that signal fires. The output (or null) is `ok: true`. In the catch: `RunHalted` is thrown on; a fired timeout is `<tool> timed out after <s> s.`; the run's own abort is thrown on; anything else is `ok: false` with its message.

## Why it works

- **The model can fix a tool error.** It can change its input, search with other words, try another document, or tell the user what failed. So a tool error is the call's result: the model reads it next turn, and OpenAI gets the answer it needs for every call it made (a call with no output makes the next request fail).
- **The model can't fix a model error.** The model is what failed, so the runner records it and asks again. Three in a row since the last good turn means something is down, and the run stops rather than spinning.
- **The race bounds the wait.** A well-behaved tool stops when its signal fires. A tool that ignores the signal still loses the race, so the loop moves on at the timeout either way.
- **Two errors aren't for the model.** `RunHalted` would read as "try another way" to a model; it has to stop the run. And a cancelled run has nobody waiting, so its abort goes up too.

## The worked example

In the recording the hung search returned `search_documents timed out after 30 s.` at seq 5. The third request carried it as the call's `function_call_output`, and the model's next turn (seq 6) is a new search, "KPC-2026-0142 payment schedule invoicing due date", which found the MSA's page 1 first. Without the error as a result, that run would have died at the first search.
