---
title: Routing
type: graded
slots:
  agent/router: router.ts
---

# Routing

👨‍💼 Kestrel's chat has two paths. The answer path (sections 06 to 10) searches once and writes a cited reply: one model call, no tools. An agent run (section 13) plans, calls tools, asks for approvals: several calls, and it can write. Users shouldn't have to pick. Every message now goes through a **router** first, one small model call that picks the path.

## Terms

- A **route** is the path a message takes: `answer` or `agent`.
- A **live run** is an agent run in the same conversation that is still `running` or `waiting` (section 14). A message routed to `agent` while a run is live goes into that run as a **follow-up**, through the message hook (section 15), instead of starting a new one.
- A **forced tool call** is a request whose `toolChoice` names one tool: the model must call it, and its arguments must fit the tool's schema. That's how the router's choice comes back as data.
- **Structured output** is any way of getting a model to answer in a fixed shape. A forced tool call is one; section 01.4's `Output.object` is another.

## Do this

🐨 In `playground/router.ts`, write `routeMessage`. The chat route calls it for every message unless the composer's "always use the agent" toggle is on.

## A worked example

Four messages, sent to gpt-6-luna at low effort on 19 October and recorded:

| Message                                                                           | Live run? | Route  | Tokens in / out |
| --------------------------------------------------------------------------------- | --------- | ------ | --------------- |
| What's the daily meal allowance on a work trip?                                   | no        | answer | 283 / 39        |
| Email Tom Whitfield the payment terms of KPC-2026-0142.                           | no        | agent  | 290 / 41        |
| Compare what versions 1 and 2 of the travel and expenses policy say about hotels. | no        | agent  | 291 / 37        |
| Actually, send it to Amara instead.                                               | yes       | agent  | 282 / 32        |

Its reason for the last one: "The user is changing the recipient of the live agent task." All four cost 1,146 tokens in and 149 out. One route is under 300 tokens in, about a sixth of an agent's first turn (Grace's sent 1,865). On its own, "send it to Amara instead" has no question and no task in it. Only the line saying a run is live makes it a correction.

Run the tests with `pnpm ex test 16.2`.
