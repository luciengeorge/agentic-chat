---
title: "Agents: durability, done"
---

# Agents: durability, done

A run now survives what servers do. On the queue, each job is one step: it reads the log, does one piece of work, writes what it did under its own key, and queues the next; a killed worker's job comes back after its lease and finds its work already written. In Workflow, the body is your loop, every piece of work a step, every decision read back from Postgres, and Workflow's record and the event log can't disagree. A mail carries a key made from its step, on every attempt, so a resend after a crash is one mail. An approval waits a week on a hook and a timer, holding nothing, and a forged resume decides nothing. A cancel aborts the model call in flight; a hung call is retried; a halt fails the run. And you built the replayer that explains the rules: a body is run again from the top, so it must ask for the same steps in the same order every time.

The sentences to say in an interview: the event log is the checkpoint; the version decides races, the step key makes a redone step a no-op, and the idempotency key covers what leaves the system; keys come from something that survives the crash (the step id), never from a random number or the clock; hooks wake and Postgres decides; one workflow drives one run, and an unknown status is left alone; a workflow body is replayed, so it must be deterministic, and changing its steps breaks open runs.

## What to notice in the lab

Open `/labs/durability` (dev only), signed in as anyone but `leo.martin`: `grace.adeyemi@kestrelpay.example`, password `dev-password`. It needs fake-workspace (`pnpm fake-workspace`) and calls the app's model, a cent or so a run.

- **Start a run.** The model plans, looks you up, and drafts a mail to you: about 9 events, then `waiting` with the send's approval.
- **Approve, holding the send 20 s.** A latency fault holds your next send in fake-workspace. The page tells you to stop the dev server: press Ctrl+C in its terminal, then run `pnpm dev` again. The page says the server isn't answering, and reconnects once it is.
- **The mail arrives first.** The request the dead server sent was still inside fake-workspace; it finishes 20 s after the approval, under `agent:<run>:step_…`.
- **Then the run comes back.** The send's step died with the server, so Workflow runs it again when its lease runs out (150 s here, 860 s by default). Same step id, same key: fake-workspace answers with the first answer, and the run ends `succeeded` with one mail. On 19 October: approved at 10:34:39, killed at 10:34:50, the mail at 10:34:59, the run done by 10:37:35, 14 events at version 13.

## What comes next

Section 16 puts runs inside runs: an orchestrator whose sub-agents are child workflows, automations that start runs on a schedule, and fan-out with backpressure. Everything here holds for each child: its own log, its own steps and keys, and the parent waiting on a hook until it ends.
