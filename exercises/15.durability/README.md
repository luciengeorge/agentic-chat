---
title: "Agents: durability"
---

# Agents: durability

Grace Adeyemi asks the agent to email Tom Whitfield a two-line summary of contract KPC-2026-0142's payment terms. Her run plans, searches, reads the contract, drafts the mail and waits for her approval. She approves. While the mail is on its way to Kestrel's Microsoft 365, the server running her run dies. When it comes back, the run must carry on by itself, finish, and Tom must get one mail: not none, not two.

Section 14 made the run a record in Postgres. This section makes it survive: a crash, a deploy, a week-long wait, a cancel in the middle of a model call. The course's main goal names "autonomous agent orchestration and state management" as the gap; durability is where the two meet. `pnpm agent:kill-proof` checks the whole of it live on the dev stack: one mail under the key `agent:<run>:<stepId>`.

## Terms

- A run is **durable** when a crash at any moment costs it some time, never its progress or a duplicate action.
- A **checkpoint** is a point a crashed program can resume from. Here it's the event log itself.
- A **step** is one piece of work: a model turn, a tool call, an approval request. Steps are where crashes are survived, one at a time.
- An action is **idempotent** when doing it twice has the effect of doing it once. An **idempotency key** names one action, so the other side can spot a repeat.
- A **workflow** (Vercel Workflow, met in section 05) is a function whose steps' results are recorded, so that after a crash it can be **replayed**: run again from the top, with finished steps answered from the record.
- A **hook** pauses a workflow until something resumes it; a **sleep** pauses it until a time. Neither holds a process while it waits.
- A **lease** is how long a worker may hold work without checking in. A dead worker's lease runs out, and its work is handed on.
- The **ownership lease** is Workflow's lease on a step. When a step starts, the process running it owns it for a fixed time, counted from the start and never renewed. Until it runs out, Workflow assumes the owner may still be working and runs the step nowhere else; after it, Workflow takes the owner for dead and runs the step again, with the same step id. Workflow's default is 860 seconds: no function on Vercel lives past 800, so by then the owner is surely gone. On this machine it's 150 (`WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS`, set in `src/workflows/start-world.ts`): just over the 120 seconds a model turn may take before its step gives up, so a slow step is never taken for dead, and a step killed with the dev server runs again two and a half minutes later.

## The steps

1. **Checkpoints and resume** (`checkpoint.ts`, `agent-runner.ts`). Run Grace's run on section 05's job queue, one step per job, and take a killed worker's job back after its lease.
2. **Idempotent side effects** (`durable.ts`, `workspace.ts`). Give every write a key from its step, and send it with every attempt, so a resent mail is one mail.
3. **The run as a Workflow** (`durable-run.ts`). Write the workflow's loop, keep Workflow's log and Postgres's agreeing, and never let two workflows drive one run.
4. **Approvals that wait days** (`durable-run.ts`). Wait on a hook, wake on the decision Postgres holds, and expire after 7 days on a timer that survives restarts.
5. **Timeouts and cancellation** (`durable-run.ts`, `durable.ts`). Abort a live model call on a cancel, and retry one that hung.
6. **Determinism and versioning** (`durable-replay.ts`). Build a small replayer by hand, and see why a workflow body may not read the clock, and why a deploy can break an open run.

Steps 1 and 3 to 5 replay Grace's recorded run (section 13's `kpc-terms`) through the app's own runners, so nothing here calls a model. Step 6 replays something smaller: a 28-step model of her run (`graceBody` in `src/core/agent/durable-testing.ts`, the same loop as `driveRun` with every effect a step), through the replayer you write. The app's runners play no part in it. Most tests need Postgres (`pnpm ex up`); steps 2 to 5 also run the real workflow in the test.

The lab, `/labs/durability`, is the kill proof by hand: start a run, approve its send while fake-workspace holds it, stop `pnpm dev` with Ctrl+C, start it again, and watch the run come back after the ownership lease and send one mail.
