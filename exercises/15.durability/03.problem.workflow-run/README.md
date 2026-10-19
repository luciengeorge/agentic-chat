---
title: The run as a Workflow
type: graded
slots:
  agent/durable-run: durable-run.ts
---

# The run as a Workflow

👨‍💼 Step 1's queue works, but it's machinery Kestrel has to keep: leases, workers, expiry jobs. Vercel Workflow does the same as a service, and section 05 already runs ingestion on it. Grace's run moves there. Its body becomes a loop; each piece of work becomes a Workflow step. The catch: Workflow keeps its own record of the run, and Postgres keeps the event log. They have to tell the same story after any crash.

## Terms

- A **workflow** is a function marked `"use workflow"`. Its **body** decides what to do; each piece of work is a **step**, a function marked `"use step"`, whose result Workflow records.
- **Replay**: on every wake-up (a step finished, a hook fired, the server restarted) Workflow runs the body again from the top. A step that already ran isn't run again: its recorded result comes straight back. So the body must reach the same point every time.
- The **two records**: Workflow's log (which steps ran and what each returned: Grace's run makes about 30 steps and 100 events there) and Postgres's `run_events` (what happened to the run: 17 events). They can't commit in one transaction.
- **`bindRun`** writes the workflow's id into `runs.workflow_run_id`, once. A **kick** is what the app does when something changes for a run (a message, a decision): wake its workflow, or start one if it has none.

## Do this

🐨 In `playground/durable-run.ts`, write `driveRun`, the body's loop: plan, then the step the plan calls for, until the run is final. `agentRunWorkflow` (`src/workflows/agent-run.ts`) binds the run, makes its hook and hands your loop the steps in `agent-run-steps.ts`.

🐨 Then write `kickAction`: given the run's workflow id and that workflow's status, whether a kick starts, wakes, replaces or leaves it. `src/workflows/agent-run-start.ts` asks it on every kick.

`waitForChange` and `unlessCancelled` are simple for now: the run waits on its own hook only, and a cancel takes effect at the next plan. Steps 4 and 5 finish them.

🚨 The classic mistake is in `kickAction`: starting a new workflow because the old one's status couldn't be read. Two workflows on one run each send Grace's mail under their own step keys: two mails.

## A worked example

Grace's run on the real workflow, her model and tools replayed. A second `start` of the same run comes back `duplicate`: `bindRun` let one workflow have it. Her approval goes through the app's waker, which asks `kickAction` and wakes the live workflow. The run ends `succeeded`. Workflow's log holds 5 model turn steps, 5 tool steps and 4 record steps, among about 30, and replayed the body from the top after each. Postgres holds 17 events at version 15, each once; the 12 a step wrote carry its key, `wf:step_…:<i>`. One mail went out, under `agent:<run>:step_…`.

Run the tests with `pnpm ex test 15.3`. They need Postgres (`pnpm ex up`).
