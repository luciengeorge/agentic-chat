---
title: "Agents: state, done"
---

# Agents: state, done

A run is now a record your code keeps. Its status moves only along the state machine, and a writer that read an old run can't move it. Its log takes each event once, numbered with no gaps, in a single statement that only the writer holding the current version gets to make; everyone else is told to read again. The model's context is rebuilt from that log every turn, whole turns at a time, newest first, from the latest summary. The browser tails the log by seq and comes back after a reload or a dropped connection with exactly what it missed. Messages, approvals and cancels that arrive together all land, in one order, each once, and a resend stores nothing. A long run compacts without losing its plan, and a user's notes stay theirs, capped, and read as data.

This is what "state management" means for an agent, and the words to say it in an interview: the log is the source of truth; the status is a fold of it; optimistic concurrency with a version decides races without holding locks while a model thinks; context is a pure function of the log; idempotency keys come from the client; and anything the run depends on (the plan, the open approvals) is carried by code, never left to the model's summary.

## What to notice in the lab

Open `/labs/state`, signed in as `leo.martin@kestrelpay.example` (password `dev-password`).

- **Start a lab run.** It's a run with one message and no runner, so nothing calls a model. The log shows seq 1, `user_message`, at version 1.
- **Send two messages at once.** Both land, at seq 2 and 3, versions 2 and 3, in whichever order the row lock gave (often the first one sent loses: it lands at 3). The resend of the first answers `duplicate` with its seq, and the log doesn't grow. Press it again: two more, never a gap.
- **Cancel the run.** One event, `queued -> cancelled`, and the run is final; the buttons go grey. A message into a final run would answer `finished` and store nothing (your 14.5 `build` returns null).
- **Pick one of your real runs** (ask the chat to email someone, with "Run as agent" on). Its log fills live, seq by seq, and the version beside each event shows where two events came in one append.
- **Open its raw stream** from the link: `/api/runs/<id>/stream` on your `stream.ts`. Add `?after=12` and only what's after seq 12 comes.

## What comes next

Section 15 makes the run durable. Today a run whose server dies mid-turn stays `running` forever: nothing picks it up. You'll run the same loop on section 05's job queue with checkpoints, then as a Vercel Workflow, and keep its two records (Workflow's own log and this one) consistent with step keys, the `stepKey` your `append` already writes.
