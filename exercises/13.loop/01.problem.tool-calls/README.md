---
title: Tool calls by hand
type: graded
slots:
  agent/loop: loop.ts
---

# Tool calls by hand

👨‍💼 Grace Adeyemi, in accounts payable, asks Kestrel's assistant: "Email Tom Whitfield a two-line summary of the payment terms in contract KPC-2026-0142." Section 10's chat can't do that. One model call answers from the passages it was handed, and that's all. Grace needs something that searches, reads the contract, looks Tom up, writes the mail and waits for her to approve it, choosing each step from what the last one found. That's an agent, and this step builds its loop.

## Terms

- An **agent** is a model in a loop: it asks for tools, the app runs them, the model reads the results and asks again, until it answers.
- A **turn** is one model call. Its reply is words, **tool calls**, or both. A tool call names the tool, its input, and a **call id** (`call_O9Lr...`).
- The **event log** is the run's history, one **event** per thing that happened: `user_message`, `assistant_turn`, `tool_result`, `approval_requested`, `approval_decided`, `status`.
- **`decide`** reads the log and says what happens next: `model`, `tools`, `approval`, `wait` or `finish`. It's pure: same log, same answer.
- A **runner** loops decide, do, append. The tests use `drive` (an in-memory log); the app uses Workflow (section 15). Both call your code.

## Do this

🐨 In `playground/loop.ts`, write `readTurn` (one model call's stream into an `assistant_turn`) and `decide`. The rest of the file is written, and its 🦉 says what belongs to later steps.

## A worked example

Grace's request, recorded on gpt-6-luna on 19 October, runs in five turns. `decide` goes:

1. `model`: the user's message is waiting. The model plans (`make_plan`, section 17), then `tools` runs it.
2. `model`. The model asks for `search_documents` and `find_person` in one turn, and `tools` runs both.
3. `model`: both results are in. The model asks to `read_document` the executed MSA. `tools`.
4. `model`. The model asks for `send_mail` to Tom. That's a write, so `approval`, then `wait` until Grace approves, then `tools`, and the mail goes.
5. `model`. A turn with no calls: "Emailed Tom Whitfield the two-line summary of the payment terms in KPC-2026-0142." `finish`.

14 events, 21,205 input tokens and 507 output, about $0.0024. The last test replays it through your loop.

Run the tests with `pnpm ex test 13.1`.
