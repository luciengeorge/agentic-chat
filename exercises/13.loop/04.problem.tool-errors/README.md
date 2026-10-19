---
title: Errors fed back to the model
type: graded
slots:
  agent/loop: loop.ts
---

# Errors fed back to the model

👨‍💼 On 14 October one of an agent's searches hung for 30 seconds: the Cohere trial allows ten reranks a minute, and three lanes were using it. A tool will fail sometimes. A search times out, a document id names a file the user can't read, the mail service answers 503. What matters is where the error goes. Grace's run shouldn't die because one search was slow.

## Terms

- A **tool error** is a call that threw or timed out. It becomes the call's `tool_result` with `ok: false`, which the model reads next turn.
- A **model error** is a model call that failed (a timeout, a 503, a dropped connection). The runner appends an `error` event; **retryable** ones are worth another try.
- **`RunHalted`** is the error the guard throws for the kill switch or a spent budget (step 6). It stops the run and never reaches the model.
- A **timeout** is how long a call may take: 30 seconds per tool call. An **abort signal** tells a tool to stop.

## Do this

🐨 In `playground/loop.ts`, write `giveUp` (when model errors end the run) and `executeCall` (a tool's output or error as the call's result). `decide` now calls `giveUp` first, and checks your step 3 caps.

## A worked example

The `search-timeout` recording: Grace asks for KPC-2026-0142's payment terms. The model plans, then calls `search_documents` with "contract KPC-2026-0142 payment terms". The search hangs. At 30 s the call's result is `search_documents timed out after 30 s.`, and the model's next turn searches again with other words: "KPC-2026-0142 payment schedule invoicing due date". That one works, it reads the MSA, and it answers: £61,400 per month, invoiced in advance, due within 30 days. Five turns, 16,241 tokens in and 345 out.

The test replays it with the first search stuck for good (it ignores its signal) and a 50 ms timeout.

Run the tests with `pnpm ex test 13.4`.
