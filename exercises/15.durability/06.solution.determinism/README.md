---
title: Determinism and versioning
type: graded
slots:
  agent/durable-replay: durable-replay.ts
---

# Determinism and versioning: the solution

`replay` keeps a call counter, the run's clock (`seen`, from `log.startedAt`) and the first divergence. Each `step` takes its index when it's called. A filled slot must have the same name and JSON arguments: then its result comes back and `seen` moves to its `at`; otherwise the divergence is kept and thrown. An empty slot runs the work with `stepId` `step_<index>`, and the result goes into that slot with `clock()`'s time. `now()` returns `seen`. After the body, a kept divergence, or logged steps the body never reached, answers `diverged`; a crash is thrown on.

## Why it works

- **Replay rebuilds what the crash threw away.** Where the body was, its local variables, which branch it took: none of it is saved, and none of it needs to be. Run the body again with every finished step answered from the log and it rebuilds all of it, then stops at the first step the log doesn't have. That's how Workflow resumes Grace's run after the kill proof's SIGKILL, and why the body has to be a function of its step results.
- **Why the body must be deterministic.** The log answers by position. If the body asks for step 3 to be a screen where the log holds a tool call, the logged result would go to the wrong question. So a different step at a place is an error. A clock read, a random number, a fetch, a database read or a global changed between wake-ups can all send the body down another branch on replay; inside a step they're logged, and outside one they're not.
- **Workflow makes some of it safe.** In a `"use workflow"` body, `Date.now()` is the time of the latest event (like `now()` here), and `Math.random()` is seeded per run, so neither diverges. Their trap is subtler: that clock doesn't move while the run waits, so a body checking `Date.now() > expiresAt` never sees the approval expire. That's why step 4 sleeps until `expiresAt`. A global `fetch` throws in a body; the database isn't reachable from one.
- **Numbered at the call.** Parallel steps finish in any order, but the body calls them in one order every time. Numbering at the call makes the place of each step a fact about the code, not about timing.
- **Side effects go in steps.** A logged step never runs again, so a mail sent from a step goes once; one sent from the body goes on every replay. A step cut short by a crash does run again, with the same `stepId`: its write needs step 2's key.

## Versioning

A replay only works on the code that wrote the log. Changing a step's body is safe: steps aren't replayed, their results are. Adding, removing or reordering steps in the body diverges every open run (the worked example's `screen`). So before such a deploy, either cancel the open runs (`ex start` does, before it swaps your code in), or ship the new body under a new name and let the old runs finish on the old one. On Vercel, Workflow pins each run to the deployment that started it, which does the second for you; the local world has one copy of the code, so it can't.

## The worked example

Fresh, Grace's run logs 28 steps and sends one mail, `agent:run-grace:step_23`. Replayed whole, nothing runs. Crashed after each of its 16 pieces of work and resumed, every run ends `succeeded` with one mail; after piece 14 (the send) there were 23 steps logged and 2 sends; after a model turn, 6 model calls. With a `screen` step added, the old log diverges at step 3. A body choosing "remind" or "wait" by the wall clock waits at 9:01 and diverges when replayed at 9:05; the same body on `now()` replays at 9:01's time and takes the same branch.
