---
title: "Agents: the loop, done"
---

# Agents: the loop, done

Kestrel's agent now runs on your loop. `readTurn` turns the model's stream into a turn: its words, its calls with their ids, what it cost. `decide` reads the log and says what's next, and because it reads nothing else, any runner can stop a run and pick it up later. `toolSpecs` and `parseCall` make one zod schema tell the model what a tool takes and check what it sends. `runUsage` and `capReached` count what a run has grown by and stop it before a cap. `giveUp` and `executeCall` send a tool's error to the model and a model's error to the runner. `runTools` runs a turn's calls together and logs them in the order they were asked for. And `holdBudget` and `createRunGuard` hold every call's tokens in Postgres before it runs, and stop a tenant's agents with one row.

The thread through all of it: the run's state is its event log. Every decision, count and cap is worked out from the events, so nothing is lost when a process dies. That's the answer to "how does an agent keep state?" in an interview, with Grace's 14 events to show it.

## What to notice in the lab

Run `pnpm dev`, sign in as `grace.adeyemi@kestrelpay.example` (password `dev-password`), and open `/labs/loop`.

- **Pick `kpc-terms`** and step through it: 11 decisions, one per row (the lab grants the approval at once, so there's no `wait`). Each model turn shows the input tokens it sent (1,865 up to 6,750) and the calls it asked for; each tool step shows its calls and results.
- **The caps column** grows as you go: 7,257 tokens by the end, against 60,000. Set the token cap to 7,000 and step again: the run finishes `failed` when the approved mail is about to run, and nothing is sent.
- **Pick `search-timeout`**: the third row is the failed search, its error in red, and the next model turn searches with other words.
- **With a step active**, the lab runs your code. Start 13.1 and the first row shows your `decide` throwing "isn't written yet"; finish it and the run plays through.

## What comes next

Section 14 keeps the log in Postgres: a state machine for the run's status, `(run_id, seq)` with optimistic concurrency, context rebuilt from the events, and messages that arrive while a run is busy. Section 15 makes a run survive a killed server, and section 17 decides which of the model's calls may run at all.
