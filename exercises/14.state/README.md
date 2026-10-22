---
title: "Agents: state"
---

# Agents: state

Leo Martin asks the agent to email Tom Whitfield a two-line summary of contract KPC-2026-0142's payment terms. The run plans, searches, reads the contract, looks Tom up, drafts the mail, and stops: it needs Leo's approval, and that can take a minute or a week. Meanwhile Leo reloads the page, approves from the inbox in another tab, and sends a follow-up ("copy Amara too") at the same moment the approval lands. A week later the run picks up where it stopped, as if nothing happened in between.

That only works if the run is a record, kept in Postgres, that every part of the app reads and writes the same way. This section builds that record. "State management" is the phrase people use for this part of agent work: these six steps are what it means for an agent.

## Terms

- A **run** is one job the agent does for a user, from the first message to the end. Its row in `runs` holds its **status** and its **version**.
- An **event** is one thing that happened in a run: a user message, a model turn, a tool result, an approval asked for or decided, a change of status, a compaction. The run's **event log** is its events in `run_events`, in order, never edited.
- **`seq`** is an event's place in its run's log: 1, 2, 3, with no gaps. `(run_id, seq)` is the table's primary key, so no two events share a place.
- **`version`** counts the run's **appends** (one write of one or more events). The recorded email run has 17 events and version 15, because two of its appends wrote two events each.
- **Optimistic concurrency** is how two writers share a run without a lock held while they think: each says which version it read, and the write only happens if the run is still at that version. The loser gets a **version conflict**, reads again and decides again.
- A **state machine** is a fixed list of the moves a status may make. A run's statuses are `queued`, `running`, `waiting`, and the four **final** ones: `succeeded`, `failed`, `cancelled`, `timed_out`.
- The **context** is what the model sees on its next turn: instructions plus messages. It's rebuilt from the event log every time.
- **Compaction** replaces the oldest part of a long log, for the model's eyes only, with a summary. The events stay in the log.
- An **idempotency key** is an id the client makes once per action, so that sending it twice has the effect of sending it once.

## The steps

All six work in `src/core/agent/`, which the app imports as `#learn/agent/<file>`.

1. **The run state machine** (`state.ts`). Refuse a status move the run can't make, even one a stale writer thinks it can.
2. **The event log** (`events.ts`). Append events with no gaps and no duplicates, and refuse a writer whose version is stale.
3. **Rebuilding context from events** (`context.ts`). Fold the log into what the model sees, within a token budget.
4. **Streaming the log** (`stream.ts`). Tail a run's events to the browser, and resume after a dropped connection from the last `seq`.
5. **Concurrent messages** (`messages.ts`). Two messages at once both land, in order, once each, and a resend stores nothing.
6. **Compaction and memory** (`compact.ts`, `memory.ts`). Summarise a long run without losing its plan, and keep a user's notes as data.

The tests replay four real runs, exported from the dev database as the app wrote them (`fixtures/cassettes/agent/runs/`): Leo's email run (`kpc-email`), a run cancelled while it waited (`cancel-waiting`), a long run that compacted before compaction kept the plan and so never sent its mail (`lost-plan`), and one that compacted twice and kept it (`two-compactions`). Nothing in this section calls a model.

The lab, `/labs/state`, tails one of your runs' events live, with each one's seq, the run's version, its type and its data, and has a button that sends two messages into a run at once.
