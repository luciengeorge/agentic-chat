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

**Why these sections matter most.** They are the gap the Cohere feedback named: "autonomous agent orchestration and state management". Each step should leave Lucien able to explain the mechanism cold, in an interview, with a number from this corpus. The 🦉 hints carry that.

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

## Wave 2 ownership

| Lane | Owns |
|---|---|
| A. 15 | `exercises/15.*/**`, `src/routes/labs/durability*`, `src/components/labs/durability*`, splits in `src/core/agent/{checkpoint,durable}*`, `src/core/queue/**` (agent runner only), `src/lib/agent-queue.ts`, `src/lib/agent-runtime.ts`, `src/workflows/agent-run*.ts` (splits only) |
| B. 16 + front door | `exercises/16.*/**`, `src/routes/labs/orchestration*`, `src/components/labs/orchestration*`, splits in `src/core/agent/{router,orchestrate,fanout}*`, `src/core/automations/**`, `src/workflows/{orchestrator,automation,workflow-agent}*.ts` (splits only), `exercises/README.md` (sections 13 to 17 now available), the `/labs` index |

**Wave 1 notes for wave 2** (from Settled):
- Sibling imports in carved files go through `#learn/...`, so a slotted copy resolves them and classes like `RunHalted` stay one class. `orchestrate.ts` still imports `./caps`; switch it.
- When a scripted test's tools include `make_plan`, the test must plan first: the AI SDK enforces a forced `toolChoice`.
- Recorded runs live in `fixtures/cassettes/agent/`. Replay them through `src/core/agent/loop-recorded.ts` or `state-testing.ts`. A test that checks each request is rebuilt byte for byte catches prompt drift.

## Settled during the build

(Lanes add what they decided here: one bullet per decision, plain words.)

**Wave 1 lane B (section 14)**

- **14's steps** (`exercises/14.state`): 14.1 `state-machine` (slot `agent/state`, stubs `transition`, `applyStatus`), 14.2 `event-log` (`agent/events`, stub `append`), 14.3 `rebuilding-context` (`agent/context`, stubs `eventGroups`, `buildContext`), 14.4 `streaming` (`agent/stream`, stubs `toSse`, `resumeFrom`, `tailEvents`), 14.5 `concurrent-messages` (`agent/messages`, stubs `appendRetrying`, `addMessage`), 14.6 `compaction-and-memory` (two slots, `agent/compact` and `agent/memory`; stubs `compactionPoint`, `planInForce`, `addNote`). All graded. Every solution is the reference byte for byte. Problem files whose stubs leave imports unused import less, with a 💰 naming what to add; 14.6's `compact.ts` has no `closedPoints` (the learner writes the closed-point walk inside `compactionPoint`).
- **Splits, behaviour unchanged.** New `#learn/agent/stream` (`toSse`, moved from `events.ts`; `toTokenSse`, `STREAM_POLL_MS`, `resumeFrom(lastEventId, after)`, `RunTail`, `tailEvents`, `sleep`, out of `handleStream` in `src/routes/api/runs/-runs.ts`). `handleStream` now drives `tailEvents` with two reads per poll (status, then events after the cursor), each in its own tenant transaction, where it read both in one; under read committed that's the same. Token forwarding stays in the route. `-runs.ts` isn't in this lane's files: it's a call-through, and it re-exports `STREAM_POLL_MS` and `toTokenSse`. New `#learn/agent/messages` (`appendRetrying`, `messageSeq`, `addMessage`, `NewMessage`, `MessageResult`, `MAX_CONFLICT_RETRIES`, plus `pgCode` and `ownStatus` exported for the problem file), moved from `src/lib/agent-runs.ts`, which imports `appendRetrying` and re-exports the rest. `addMessage` reads the run's status and owner with one SQL query instead of `loadRun` (core can't import the glue). `context.ts` imports `#learn/agent/prompt` (it was `./prompt`, which a slotted copy can't resolve) and exports `userMessages`; `compact.ts` exports `planInForce`. The app's tests pass unchanged.
- **Recordings, without a model call.** `fixtures/cassettes/agent/runs/` holds four real runs' `runs` row and `run_events`, exported from the dev database on 2026-10-19 exactly as the app wrote them ($0): `kpc-email` (leo.martin, 18 Oct, section 12's recording: 17 events, version 15), `cancel-waiting` (tom.whitfield's smoke run, cancelled while waiting: 11 events, version 9), `lost-plan` (tom.whitfield, 14 Oct, the run that compacted before compaction kept the plan, replanned at seq 18 and was refused at 19: 21 events), `two-compactions` (daniel.reyes, compactions at 16 and 23, both with the plan: 25 events, version 23). `src/core/agent/state-testing.ts` reads them (`recordedRun`, `recordedEvents`) and writes one into a test database with plain SQL (`stateWorld`, `loadRecorded(sql, world, name, { throughSeq, runId, eventsToo })`), so a step's setup never runs a slotted function. A run's version isn't stored per event; an append is one statement, so its events share their `at`, and `appendsOf` groups them: on all four runs the groups count to the version (tested in `state-testing.test.ts`).
- **Numbers the READMEs use.** Leo's run: status moves at seq 2, 12, 14, 17; at seq 12 it's version 10 (not 11: seq 6-7 and 11-12 were one append each). The race at version 10: the approval wins seq 13 at version 11, the follow-up waiting on the row lock gets a conflict, a late writer is told "run 52a826fa-… is at version 11, not 10". Context: 6 groups, 11 messages, 4,883 tokens; at a budget of 4,000, 5 messages and 2,627 (the search turn would make 4,748). Stream: `?after=12` gives 13 to 17, `Last-Event-ID: 15` with it gives 16 and 17. Three writers from seq 12 end at seq 15, version 13; the cancel that read `waiting` rebuilds as `running -> cancelled` at version 12. Lost-plan: 16,285 live tokens at seq 16, cut at 12 (13 mid-call, 3,575 tokens after 14); context 15,675 tokens before, 5,630 with the summary that lost the plan, 5,700 with the plan kept; the second cut of `two-compactions` is 18 at 19,417 live tokens, still naming the seq-3 plan. Daniel's note "I prefer answers as short bullet points." (from the 14 Oct live scenarios).
- **Tests that force a race.** 14.2 holds the winner's transaction open until the loser is waiting on the row lock; 14.5 locks the run's row from another transaction while three writers do their reads, and slips a writer in after the learner's first `tx.execute` (a proxy) to make `appendRetrying` rebuild; 14.4 drives `tailEvents` with a fake log that commits an event and the final status between the learner's two reads. Each turns a timing bug into a failure every run.
- **Wrong answers.** Each step ran against 6 to 13, each failing with a message that names it: only the move checked, only the `from` checked, refusing events after final, the error naming the event's `from`, `transition` returning `from`, same-status moves allowed (14.1); the version checked only in JavaScript, insert before update, version per event, one seq per batch, no state machine, retrying inside `append`, no `finished_at`, the step key without its index (14.2); results as their own group, an orphan result kept, no result for a refusal, `continue` past a misfit, oldest first, summary only, replaying what the summary covers, no sort, the newest group not forced (14.3); events before status, final before draining, a sleep after each page, a stuck cursor, replaying from the top, the query before the header, no validation, no `id:`, a busy loop (14.4); no re-read, events built once, no retry, no dedupe, no 23505 retry, a message into a finished run, dedupe by text (14.5); any seq as a cut, an approval request counted as an answer, a refusal left open, all events counted, the first point, the last `make_plan` as the plan, the plan from live events only, a plan carried past a new message, pretty-printed JSON, evicting the oldest note, no lock, case-sensitive dedupe, no normalising (14.6).
- **The lab.** `/labs/state` (`src/components/labs/state-server.ts`, server functions in the route behind `viewerMiddleware`, the viewer's own runs only, so not dev-only): pick one of your 20 newest runs and its log tails every 500 ms until it's final, each event with seq, version, type and data. Run, version and events come from one statement, so they agree. Each event's version is the dense rank of its append, numbered by the append's first seq, not its time: a race's loser started its transaction first, so its `at` is earlier though its seq is later (seen live). "Start a lab run" makes a `chat` run with no conversation and a `lab-` message id and no runner (nothing calls a model); "Send two messages at once" runs two `addMessage` concurrently through `#learn/agent/messages`, then resends the first; "Cancel" uses `cancelRun`. Sends and cancels are refused on real runs, whose runner wouldn't be told. "Raw stream" opens `/api/runs/<id>/stream`. Clicked through on the dev server as leo.martin: the first message lost the race and landed at seq 3, the second at 2, the resend answered `duplicate` at 3; again at 4 and 5; the cancel was seq 6, version 6; `?after=3` streamed 4 to 6 and ended. That left one cancelled lab run in leo.martin's dev runs.
- **Left alone.** 12.4's problem file points at `resumeFrom` in `-runs.ts`; it's still called there, now imported from `#learn/agent/stream`.

**Wave 1 lane A (sections 13 and 17)**

- **13's steps** (`exercises/13.loop`, lab `/labs/loop`): 13.1 `tool-calls` (slot `agent/loop`, stubs `readTurn`, `decide`), 13.2 `tool-registry` (`agent/loop`, stubs `toolSpecs`, `parseCall`), 13.3 `caps` (`agent/caps`, stubs `runUsage`, `capReached`), 13.4 `tool-errors` (`agent/loop`, stubs `giveUp`, `executeCall`), 13.5 `parallel-calls` (`agent/loop`, stub `runTools`), 13.6 `budgets` (`agent/budget`, stubs `holdBudget`, `createRunGuard`). All graded. 13.3 to 13.6's solutions are the reference byte for byte. 13.1 and 13.2's `decide` has no caps and no error rule (`_caps` unused, no `giveUp`, no `MAX_RETRIES`); 13.4's problem file adds them back, listed in its 🦉. The approval and policy sorting (`pendingCalls`) is written in every step: sections 15 and 17 teach it. Problem files whose stubs leave an import unused import less, with a 💰 naming it (`z` in 13.2, `message` gone from 13.4, `RunHalted` in 13.6).
- **17's steps** (`exercises/17.safety`, lab `/labs/safety`): 17.1 `acting-user` (two slots, `agent/tools/send-mail` and `agent/tools/share-document`; stubs each tool's `execute`), 17.2 `poisoned-document` (`agent/loop` and `agent/plan`; stubs `planningInput`, `planningTurn`), 17.3 `plan-then-execute` (`agent/plan` and `agent/policy`; stubs `uncovered`, `planPolicy`, `subagentPolicy`), 17.4 `guardrails` (`agent/guardrails`; stubs `quotableSpans`, `screenMail`). All graded; every solution is the reference. The M2 review's holes are 17.3's classic mistakes, each with a failing test (entries mixed, path words, sub-agents as the user); the automation filename is a 🦉 only, since `#learn/automations/automation` isn't one of this section's slots.
- **Splits, behaviour unchanged.** `loop.ts`: `readTurn` (the stream into an `assistant_turn`, out of `modelTurn`), `pendingCalls` (the turn's calls sorted by the gate, out of `decide`), `giveUp` (the error rule, out of `decide`), `parseCall` (lookup and `safeParse`, used by `runTool` and `approvalNeeded`), `executeCall` (context, timeout race and catch, out of `runTool`); `planningInput` and `FINAL` exported; the private `planningTurn(context, tools)` renamed `isPlanningTurn`. `plan.ts` exports `planningTurn`; `policy.ts` exports `ALLOW` and `deny`; `guardrails.ts` exports `screenMail`, its lookups (`mailDomains`, `principalByEmail`, `documentLabel`, `quotedDocuments`, `principalCanRead`, `label`, `isUuid`, `Principal`) and `QUOTE_STEP`, `MAX_QUOTES`; `budget.ts` exports `liveHolds`, `heldTokens`. `loop-testing.ts`'s `drive` takes `toolTimeoutMs`. The app's tests pass unchanged.
- **Imports through `#learn`.** A slotted copy can't resolve `./x`, and a module importing `./loop` would get the reference `RunHalted` while the learner's loop throws its own. So `loop`, `loop-testing`, `caps` (now `countTokens` from `#learn/model/tokens`), `budget`, `plan`, `policy`, `prompt`, `guardrails` and every `tools/*` import their siblings as `#learn/agent/...`; `checkpoint.ts` and `durable.ts` (not this lane's files) changed only their `RunHalted` import. `orchestrate.ts` still imports `./caps` (its `runUsage` is pure, so mixing is harmless); wave 2 may want to switch it.
- **Recordings** (`fixtures/cassettes/agent/{kpc-terms,search-timeout,brightwell}.json`, read by `src/core/agent/loop-recorded.ts`: `recordedRun`, `replayAgentModel`, `replayTools`, `replayGuard`). Recorded 2026-10-19 by a script that isn't committed: `drive` with the app's six tools (`createAgentTools`), `agentGuard` (real budget and guardrails), real retrieval on the dev database, an in-process fake-workspace for writes, gpt-6-luna at medium, approving every write; each file holds every model request and its raw SSE, each tool call's start and end, the event log and the mail sent. `kpc-terms` (grace.adeyemi: 5 turns, 1,865 / 1,949 / 4,109 / 6,532 / 6,750 in, 507 out; search 5,122 ms and find_person 7 ms in one turn; one mail to Tom), `search-timeout` (grace, the first search made to hang: 30 s timeout fed back, the model searched again; 16,241 in, 345 out), `brightwell` (ella.brooks: the pack's paragraph in requests 3 and 4, the answer says it ignored it; 13,688 in, 778 out). Cost about $0.006 with retrieval. `loop-recorded.test.ts` replays each through `drive` into the same events and checks every request is rebuilt byte for byte, so a change to the prompt, context or a tool's schema fails there first (re-record then). A replayed `make_plan` with no recorded result runs as itself, so tests can script past a recording.
- **Numbers the READMEs use.** Grace's run: 11 decisions in the lab (12 with the `wait` the app's runner sees), 14 events, tokens counted 7,257 against 21,712 billed; a 10,000-token cap finishes, 7,000 stops before the mail (7,011 used); the six tool specs 1,474 tokens (`make_plan` 408; 1,576 with `$schema`, 1,509 on the output side); planning-turn hold 6,033 (2,033 + 4,000), settled at 1,970. 17: grace reads 18 of 40 documents, tom 19, daniel 25 (the Heron memo among them), ella 9; Kestrel's one mail domain `kestrelpay.example`; the memo's 21-word sentence "If the board approves on 20 October..." gives 5 runs and flags Daniel's mail to Tom.
- **Test worlds.** 13.1 to 13.5 and 17.2, 17.3 need nothing running. 13.6 builds its tenants with plain SQL (as `budget.test.ts`). 17.1 uses section 09's `setupAclWorld()` (directory and drive) and a separate `setupRealWorkspace()` app for the writer; the item ids agree because both come from the committed manifest. 17.4 uses `setupAclWorld({ chunks: true })` for the memo's real text. The AI SDK enforces a forced `toolChoice`, so a scripted test whose tools include `make_plan` has to plan first (13.2 leaves `make_plan` out).
- **Wrong answers.** Each step ran against 5 to 9, each failing with a message that names it: finishing once results are in, a newer message ignored, the first turn, no final-status check, text replaced, the tool from the call id, no finish accepted, answered calls run again (13.1); `$schema` kept, the output side, `.parse` throwing, the raw input, a plain message, an unknown tool throwing (13.2); summed input, no output, negative after compaction, calls counted when asked, waiting counted, the batch not counted, the turn cap on tools, `>` for `>=`, a child's spend ignored (13.3); rethrown errors, no race, `RunHalted` to the model, a cancel to the model, the abort's message, undefined output, giving up late, every error fatal, a fatal one retried (13.4); completion order, one after another, `Promise.all`, a halt dropped, the first call only (13.5); read then write, holds ignored, lapsed holds kept, the switch on turns only, today's row for the settle, a check without a hold, the everywhere switch ignored, the hold not dropped (13.6); no attachment check, checking as it sends, a "you don't have access" message, a fresh key, sharing as the recipient, sharing an unread document, a disabled recipient (17.1); the full context, `planning` ignored, the summary kept, the latest `make_plan`, the run's first turn, the first message (17.2); entries mixed, path words, attachments ignored, unresolved attachments allowed, no screen allowed, any `make_plan`, a flag allowed, a sub-agent under the plan policy, a share from two entries (17.3); a domain by its ending, no directory check, attachments unchecked, no attachment flag, quotes of unreadable documents flagged, runs every 8 words, no last run, no squashing, no cap (17.4).
- **The labs.** `/labs/loop` (`src/components/labs/loop-server.ts`, not dev-only: it replays recordings) runs a recording through `#learn/agent/*` as `drive` does, approving at once, with caps from the page, and shows each step: the decision, a turn's tokens, text and calls, each result, the usage against the caps; code that throws ends the run with its message. `/labs/safety` (`safety-server.ts`, dev only, refused outside dev and said on the page and in `/labs`) runs the chosen red-team scenarios on the obeying model through `#learn/agent/*` and `#learn/redteam/*`, on the dev database with retrieval finding nothing (the plants carry the attacks, as in smoke's red-team check), writes going to a fake-workspace created for the request (never the running one), notes deleted as they're read. Both are in the `/labs` list. Clicked through on the dev server as leo.martin: the loop lab at a 7,000-token cap finished `failed` after the approval with nothing sent; the safety lab held 15 of 15. Both server modules have tests (`safety-server.test.ts` runs all fifteen on the ACL world).
