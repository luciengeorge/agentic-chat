---
title: Determinism and versioning
type: graded
slots:
  agent/durable-replay: durable-replay.ts
---

# Determinism and versioning

👨‍💼 Two rules came with Workflow, and Kestrel's engineers keep asking why. A workflow body may not read the clock, the network or the database. And a deploy that changes a body's steps can break the runs that were open when it shipped. Both rules come from how a run resumes. Build that small, by hand, and the rules explain themselves.

## Terms

- A **replayer** resumes a run by running its body again from the top, answering each step the body asks for from the run's **log** (what each step returned, in the order the body asked), and running for real only the steps the log doesn't have. Workflow is one; you'll write a 40-line one.
- A **deterministic** body asks for the same steps, with the same arguments, in the same order, whenever it's given the same step results.
- A **divergence** is a replay that asks for something other than what the log holds at that place. The log no longer describes the code, so the run can't safely go on. (Workflow retries a divergent replay a few times, then fails the run with `CORRUPTED_EVENT_LOG`.)
- The run's **clock** is the time of the latest step the body has a result from: the same on every replay. Workflow pins `Date.now()` in a body to it, and seeds `Math.random()` per run, for this reason.
- **Versioning**: what to do with open runs when the body's code changes.

## Do this

🐨 In `playground/durable-replay.ts`, write `replay(body, log, clock)`. The types, `ReplayDivergence` and `newRunLog` are written. Nothing in the app calls it: the tests run Grace's run through it as a 28-step log, and smaller bodies that break the rules.

🚨 The classic mistake, in a body, is reading the wall clock (or anything outside the log) to decide which step comes next. Your replayer must catch it: a body that read `Date.now()` takes another branch when it's replayed later, and that's a divergence, never a quiet guess.

## A worked example

Grace's run as a log: 28 steps (12 plans, 5 model turns, 5 tool calls, 4 records, the approval asked and decided), with 16 pieces of work among them. The tests crash it after each of the 16 in turn (the work done, the log not told) and resume it. All 16 end `succeeded` with one mail, `agent:run-grace:step_23`. A crash right after the send, piece 14, leaves 23 steps logged; the send runs again under the same step id, so the same key: two sends, one mail. A crash right after a model turn (pieces 1, 4, 8, 11, 16) costs one more model call, 6 instead of 5, and never a second turn.

Then a deploy adds a `screen` step before every tool call. Grace's open run, logged by the old code, diverges at step 3: "the log has tool("make_plan"), the body asked for screen("make_plan")".

Run the tests with `pnpm ex test 15.6`.
