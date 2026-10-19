---
title: The run as a Workflow
type: graded
slots:
  agent/durable-run: durable-run.ts
---

# The run as a Workflow: the solution

`driveRun` loops on `steps.plan()`. `not-found` returns at once; `final` breaks with the plan's status; `waiting` goes to `waitForChange`, and a cancel there ends the run `cancelled`. For `act`: an approval is `steps.approval`; a model turn is `steps.modelTurn` inside `unlessCancelled`; a turn's tools all start at once with `Promise.all`, a live delegate call to `steps.delegate(call, delegates, calls.length)` and every other call to `steps.tool`, inside `unlessCancelled`. A halted outcome fails the run with its reason; otherwise the result outcomes go to one `steps.record`, in call order. The whole loop sits in a `try`: a step that failed for good is `steps.fail(message)` and the status `failed`.

`kickAction` answers `start` with no workflow id, `leave` for a status it couldn't read, `reconcile` for `cancelled`, `replace` for `completed`, `failed` or `gone`, and `wake` for the rest.

## Why it works

- **The body is a pure function of step results.** Every branch is on what `plan` returned, and `plan` read Postgres inside a step. On replay those results come back from Workflow's log in the same order, so the body walks the same path and reaches the step it was waiting on. This is why `plan` is a step and not a query in the body.
- **Postgres is the truth; Workflow's log is the bookmark.** Workflow remembers which steps ran. Postgres remembers what happened to the run. A step writes Postgres first and returns after, so a crash in between leaves Workflow thinking the step never finished. It runs it again, and the step finds `wf:<stepId>:0` already in `run_events` (the unique `(run_id, step_key)`) and writes nothing. Decisions are read back from Postgres every time, so a message, a decision or a cancel written by a route is seen by the next plan.
- **One workflow per run.** Each workflow's steps have their own ids, so their own step keys and idempotency keys. Two workflows on one run would both append (a version conflict would throw one turn away, but not before both called the model) and both send. `bindRun` stops two starts at once; `kickAction` stops a kick from starting a second driver while the first may be alive. Only a workflow Workflow says has ended is replaced; anything unsure is left for the next kick.
- **A crashed workflow resumes on its own.** In dev, Workflow's local world re-queues every open run at boot (`src/workflows/start-world.ts`). A step that died mid-flight runs again when its owner's lease runs out: 860 seconds by default, sized for Vercel; 150 here (`WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS`), just over the 120 s model step timeout, so a restarted dev server picks a killed step up within two and a half minutes.

## The worked example

The second start answers `duplicate`. The approval goes through `workflowWaker`: `kickAction("wrun_…", "running")` is `wake`, and the run hook gets `{ kind: "wake" }`. The run ends `succeeded`: 17 events at version 15, 12 of them keyed `wf:step_…:<i>`, the send's result once, one mail under `agent:<run>:step_…`. Workflow's log shows 5 `modelTurnStep`, 5 `toolStep` and 4 `recordStep`, and every wake-up replayed the body from the top without writing anything twice.
