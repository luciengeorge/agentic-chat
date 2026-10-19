---
title: "Agents: the loop"
---

# Agents: the loop

Sections 06 to 10 built one answer: a question goes in, retrieval finds passages, one model call writes the reply. Kestrel's people also ask for things that take several steps: "email Tom the payment terms of KPC-2026-0142" means find the contract, read it, look Tom up, draft the mail, and wait for the user to approve it. An **agent** does that. It's a model in a loop: the model asks for a tool, the app runs it, the model reads the result and asks again, until it answers.

This section builds the loop by hand, one piece at a time, on the app's real tools and a real recorded run. The course's main goal names this as the gap: autonomous agent orchestration and state management. By the end of the section you can say exactly how a run decides its next step, what stops it, and what happens when something fails.

## Terms

- A **turn** is one model call. Its reply is words, **tool calls**, or both. A tool call names a tool, its input and a **call id**.
- A **tool** is a function the agent may ask for: `search_documents`, `read_document`, `find_person`, `send_mail`, `share_document`, and `make_plan` (section 17). Each has a zod **schema** for its input.
- The **event log** is the run's history, one event per thing that happened. The log is the run's state: nothing else remembers where a run is.
- **`decide`** reads the log and says what happens next. A **runner** loops decide, do, append.
- A **cap** is a per-run limit: model turns, tool calls, tokens, active time. The **daily budget** is a per-user limit on tokens, and the **kill switch** stops a tenant's agents at once.
- A **recording** is a real run on gpt-6-luna, kept in `fixtures/cassettes/agent/` with every request and reply. The tests replay three of them, so nothing here calls a model.

## The recordings

Made on 19 October 2026 with the app's six tools, real retrieval and an in-process fake-workspace, approving every write:

- **`kpc-terms`**: Grace Adeyemi (accounts payable) asks "Email Tom Whitfield a two-line summary of the payment terms in contract KPC-2026-0142." Five turns, one mail to Tom.
- **`search-timeout`**: Grace asks for the same terms without the mail, and her first search is made to hang, as one did behind the Cohere trial's rate limit on 14 October.
- **`brightwell`**: Ella Brooks asks what the Brightwell onboarding pack wants done before go-live. The pack carries planted instructions (section 17).

## The steps

1. **Tool calls by hand** (`agent/loop`: `readTurn`, `decide`). Read a turn off the model's stream, and decide what happens next from the log.
2. **A typed tool registry** (`agent/loop`: `toolSpecs`, `parseCall`). One zod schema per tool, sent to the model as JSON Schema and checked when the model calls it.
3. **Per-run caps** (`agent/caps`: `runUsage`, `capReached`). Count a run's use from its events, and stop it before a cap, never after.
4. **Errors fed back to the model** (`agent/loop`: `giveUp`, `executeCall`). A tool's error goes to the model; a model's error goes to the runner.
5. **Parallel calls** (`agent/loop`: `runTools`). A turn's calls run together; their results go in the log in call order.
6. **Daily budgets and the kill switch** (`agent/budget`: `holdBudget`, `createRunGuard`). Postgres holds each call's tokens before it runs, and one row stops a tenant's agents.

Steps 1 to 5 need nothing running. Step 6 needs Postgres (`pnpm ex up`). The lab, `/labs/loop`, steps through a recorded run on your code: each decision, each turn, each call and its result, and the caps used so far.
