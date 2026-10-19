# M4 contract (exercises 13 to 17: agents)

M4 carves sections 13 to 17 out of the M2 agent runtime, the same way M3 carved 00 to 12.

**What still holds.** **`docs/m3-contract.md` is the template and still binds, all of it:**
- "Who the learner is";
- "Step layout";
- "Hints";
- "Tests";
- "Labs";
- "Writing style";
- the four "What ... taught" sections.

`docs/m2-contract.md`'s Settled section describes the code the steps are carved from. If a lane has to break either contract, it says so in its report.

**M4 is done when:**
- every step of sections 13 to 17 exists;
- `pnpm ex gate` passes for every graded step;
- every section has its lab;
- the front door (`exercises/README.md`) and the `/labs` index list sections 13 to 17;
- fresh reviewers have read every README.

**Why these sections matter most.** They are the course's main goal: "autonomous agent orchestration and state management". Each step should leave Lucien able to explain the mechanism cold, in an interview, with a number from this corpus. The 🦉 hints carry that.

| Wave | Lanes |
|---|---|
| 1 | A. Sections 13 (the loop) + 17 (safety). B. Section 14 (state) |
| 2 | A. Section 15 (durability). B. Section 16 (orchestration), plus the front door and `/labs` index for 13 to 17 |

## Rules carried over (short form)

- **Never touch the learner's playground.** Lucien has steps active while lanes work. Lanes never run `pnpm ex start`, `reset`, `solution` or `stop`, and never touch `playground/` or `.ex/`. Check steps with `pnpm ex test <id> --target problem|solution` and `pnpm ex gate`.
- **A step folder appears with its README.**
- **Record once, replay in tests:**
  - agent runs on gpt-6-luna go into `fixtures/cassettes/agent/` once;
  - tests use `scriptedTurns` or the recordings, never a live call;
  - live runs use a user other than `leo.martin`, whose daily budget runs low.
- **Workflow steps:**
  - a stub inside a workflow step throws `FatalError`;
  - workflow tests are `*.workflow.test.ts`;
  - `RetryableError`'s `retryAfter` is passed in as data.
- **Wrong answers:** try 3 to 8 plausible ones per step, and name them in the report. Copies go in a scratch folder inside the repo, deleted after.
- **Test setup never calls a slotted function.**
- **The dev server:** start `pnpm dev` only if `:3000` is free, and stop it after.
- **Agent rules:** never stop Docker or OrbStack, no nested subagents, don't commit, and don't write to the Obsidian vault.

## Wave 1 ownership

| Lane | Owns |
|---|---|
| A. 13 + 17 | `exercises/13.*/**`, `exercises/17.*/**`, `src/routes/labs/{loop,safety}*`, `src/components/labs/{loop,safety}*`, splits in `src/core/agent/{loop,caps,budget,tools/**,plan,policy,guardrails,prompt}*` and `src/core/redteam/**` |
| B. 14 | `exercises/14.*/**`, `src/routes/labs/state*`, `src/components/labs/state*`, splits in `src/core/agent/{state,events,context,compact,memory}*` and `src/lib/agent-runs.ts` |

Shared files (`src/routes/labs/index.tsx`, `-functions.ts`, `package.json`, this contract's Settled section): re-read right before writing, and change only your lines.

## Section notes

**13 Agents: the loop** (6 steps, lab: run stepper)
- **The steps:**
  1. tool calls by hand (the loop: call the model, run the tool, feed the result back, repeat);
  2. a typed tool registry with zod (validation errors go back to the model);
  3. per-run caps and budgets;
  4. errors fed back to the model;
  5. parallel calls (`Promise.allSettled`, results appended in call order);
  6. per-user token budgets and the kill switch (including the budget hold from M2's review).
- **Carve from:** `#learn/agent/loop` (`decide`, `modelTurn`, `runTool`, `runTools`), `caps`, `budget` and the tools.
- **Lab:** step through one run with a scripted or recorded model: each `decide`, each model turn, each tool call and result, and the caps used so far.

**14 Agents: state** (6 steps, lab: live event log)
- **The steps:**
  1. the run state machine;
  2. the event log with `(run_id, seq)` and optimistic concurrency (`version`);
  3. rebuilding context from events;
  4. streaming step events and tokens (SSE with `Last-Event-ID`);
  5. concurrent messages with idempotency keys;
  6. compaction and memory (the plan survives compaction; notes are data, not instructions).
- **Lab:** a run's `run_events` tailing live, with seq, version, type and data, and a "send two messages at once" button that shows both land, in order, once each.

**15 Agents: durability** (6 steps, lab: kill the server)
- **The steps:**
  1. checkpoints and resume by hand on the section 05 job queue (the runner in `src/lib/agent-queue.ts`, carved into `src/core`);
  2. idempotent side effects (the key from the step, and fake-workspace's `Idempotency-Key`);
  3. the run as a Vercel Workflow, with the two records kept consistent (`step_key`);
  4. approvals as hooks that wait days (the 7-day timeout, and a decision read back from Postgres);
  5. timeouts and cancellation, aborting a live model call;
  6. determinism and versioning. This step is graded if a test can catch a non-deterministic workflow function, otherwise `guided`, and the lane says which.
- **Real numbers:** the kill proof (one mail with the key `agent:<run>:<stepId>`), the 150-second local lease and why it exists, and the review's "two workflows on one run" race.
- **Lab:** start a run whose `send_mail` is held by a latency fault, then a button that tells the learner to kill `pnpm dev` (Ctrl+C) and start it again. The page reconnects and shows the run resume, and one mail in fake-workspace. The page never kills the server itself.

**16 Agents: orchestration** (6 steps, lab: run tree)
- **The steps:**
  1. workflows vs agents (`guided` or graded: the lane decides);
  2. routing;
  3. an orchestrator with read-only sub-agents as child workflows, whose spend counts against the parent;
  4. automations on schedules and triggers (ids only, owner-readable documents);
  5. fan-out with backpressure;
  6. the same agent on `WorkflowAgent`, compared (`guided`, as PLAN says).
- **Lab:** a run tree. A parent run with its child runs, each child's caps and spend, and the parent's remaining cap.

**17 Safety** (4 steps, lab: red-team runner)
- **The steps:**
  1. authorisation as the acting user;
  2. the poisoned document;
  3. plan-then-execute with an action allowlist, including the M2 review's holes as the classic mistakes (attachments matched by path words, entries mixed across a call, sub-agents treated as the user, a filename in an automation's message);
  4. guardrails at the server boundary.
- **Lab:** the red-team runner. Pick scenarios, run them on the scripted model, and see each attacking write refused (or let through, while the learner's step is unfinished).

## Settled during the build

(Lanes add what they decided here: one bullet per decision, plain words.)
