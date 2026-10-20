# M5 contract (the workshop UI, then sections 18 to 22)

M5 finishes the course: a workshop UI in the browser, and sections 18 to 22. **`docs/m3-contract.md` and `docs/m4-contract.md` are still the template and still bind:**
- learner and writing rules;
- hints, tests and labs;
- the four "What ... taught" sections;
- machine etiquette.

If a lane has to break them, it says so in its report.

Decisions Lucien made for M5:
- **The UI comes first.** The workshop UI is built and merged to main on its own, so he can use it for sections 01 to 17 while the rest is built.
- **Deploys are his.** Section 22's steps are written and checked locally (build, migrations, CI). Lucien runs the deploy himself, on his own Vercel and Fly or ParadeDB accounts. Nothing is deployed, billed or published by a lane.
- **Local models run on LM Studio,** which is installed. Its OpenAI-compatible server on `:1234` is reached through the AI SDK. The local reranker is transformers.js, as `PLAN.md` says: `AutoModelForSequenceClassification`, then a sigmoid, never the pipeline API.
- **Drills go through an `ex drill` command.** `pnpm ex drill <id>` plants a hidden fault in the running app and shows the symptom. The learner finds and fixes the cause, `pnpm ex drill check` grades it, and `pnpm ex drill reset` restores the app. The learner must not be able to see which file holds the fault.

| Wave | Lanes |
|---|---|
| 1 | U. The workshop UI (merged to main after its own review). R1. Reference for 18 and 19 |
| 2 | R2. Reference for 20 (the drill mechanism and five faults) and 21 |
| 3 | Sections 18 + 19; sections 20 + 21 |
| 4 | Section 22, plus the front door and the `/labs` index |

**Every wave keeps these rules:**
- Lucien has a step active. Lanes never run `ex start`, `reset`, `solution` or `stop`, and never touch `playground/` or `.ex/`.
- **Who runs what.** In a parallel wave, lanes run only their own tests (`pnpm vitest run <their files>`), plus `lint:check`, `format:check`, `typecheck` and `build`, and `ex test <id> --target ...` for their own steps. Main runs the full suite and the whole gate once both lanes are done. Two full suites at once push the load average to about 30 and cause timeouts.
- Stop only processes you started, by PID.
- Never use Lucien's browser sessions.
- No nested subagents, no commits, no vault writes.

## Wave 1, lane U: the workshop UI

**Where:** `/workshop` in the app, behind sign-in, dev only (`acEnv() === "dev"`, refused otherwise, since it runs `ex` on the machine).

**What it does:**
- **Step list:** sections and steps from `pnpm ex list --json`, with each step's type and status, and the active step marked.
- **A step page:**
  - the README rendered (markdown, with the hint legend);
  - the problem file's hints shown beside it;
  - a "start this step" button (`ex start`, which refuses to discard playground changes, as the CLI does: show its message, and offer `--force` only behind a confirm);
  - the lab link.
- **Test runner:** runs `ex test <id> --json` and streams progress as it goes. Each test shows pass or fail, with its failure message, in plain text and no colour codes.
- **Diff:** `ex diff <id>` shows the playground against the solution. Hidden by default behind a "show the solution diff" button, since looking is a choice.
- **Progress:** passed steps marked, from `.ex/state.json` through `ex list --json`.

**How it's built:**
- **No second implementation.** Server functions call the `ex` CLI's own functions in-process where they're exported (`scripts/ex/*`), or spawn `pnpm ex ... --json`. The logic stays in one place, as `PLAN.md` says.
- **Streaming:** a server route streams test progress (SSE or a `ReadableStream`), with heartbeats and abort like the chat route.

**The UI must not break the learner's state:**
- `ex start` and the others swap playground files and restart the dev server, which is serving the UI itself. Handle that: the page reconnects after the restart and shows the new active step.
- Concurrent clicks must not start two swaps at once.

**Taste.** This is the course's front room. Follow the repo's UI rules (shadcn on Base UI, semantic tokens, `gap-*`, `size-*`, hugeicons) and make it calm and readable: README first, tools beside it. It should feel like a good docs site, not an admin panel.

**Tests:**
- component tests for the step list, the test result rendering and the diff toggle;
- server tests for the `ex` calls, run on a test repo (`scripts/ex/test-repo.ts`), never the real one;
- one check through the running app, if `:3000` is free.

**The UI lane owns:**
- `src/routes/workshop/**` and `src/components/workshop/**`;
- small, exported, tested additions to `scripts/ex/**`, if the UI needs a function the CLI doesn't export;
- a "Workshop" link in the app sidebar.

## Wave 1, lane R1: reference for 18 and 19

This lane builds reference code only. The steps come in wave 3.

**18 Evals:**
- **Claim decomposition** (`#learn/eval/claims`): split an answer into atomic claims with structured output, then check each against the cited sources.
- **Judge calibration** (`#learn/eval/judge`): an LLM judge that scores an answer's faithfulness, plus a small set of hand labels to calibrate it against. Agreement is measured as Cohen's kappa, defined in plain words.
- **Agent task evals** (`#learn/eval/agent-tasks`): a handful of scripted agent tasks with expected outcomes, scored, and runnable in CI on recordings.
- **Lab:** an eval dashboard over `fixtures/golden/reports` and these new evals.
- **Records:** recorded judge and claim calls, so tests replay them; no live calls in tests.

**19 Observability:**
- **Spans:** OpenTelemetry spans with the GenAI semantic conventions. The AI SDK emits spans for model calls when told to; add spans for retrieval, tools and runs.
- **Local stack:** `grafana/otel-lgtm` in Compose under a profile, pinned to an exact tag, started only for section 19.
- **Metrics:** counters and histograms for latency, tokens, cache and denials.
- **Cost per request:** from usage and a price table, kept in one place.
- **Conversation log fan-out:** conversations exported as JSON lines to a sink, through the outbox, so a slow sink never slows a chat.
- **Off by default:** the app runs exactly as now when the collector is off.

**R1 owns:**
- `src/core/eval/**` (additive);
- `src/core/observability/**` (new);
- the instrumentation hooks it adds in the app (small, behind config);
- `compose.yaml` (the profile only);
- `scripts/` for these features.

## Wave 2 (two lanes, reference only)

| Lane | Owns |
|---|---|
| D. Drills (section 20) | `scripts/ex/drill*.ts` and their tests, `scripts/ex/cli.ts` (the `drill` command only), `src/core/drills/**` (fault definitions), `fixtures/drills/**`, the lab data the drills need |
| L. Air-gapped (section 21) | `src/core/local/**` (LM Studio client, local embeddings, the transformers.js reranker), the config switch that selects local models, `compose.yaml` (an egress-blocked profile only), `scripts/vendor*.ts`, `package.json` (its deps and scripts) |

**Lane D, drills:**
- `pnpm ex drill <id>` plants one fault in the running app, then prints the symptom only: what a user or an on-call alert would see.
- `ex drill check` grades by behaviour: the symptom is gone, and the fault's own test passes.
- `ex drill reset` restores the app.
- **Hiding the fault.** The learner can't see which file holds it. Faults live outside the repo's tracked files (for example applied from an encrypted or out-of-tree patch, or a config or database flip), and `git status` and `git diff` must not point at the answer. Say how this is done and how strong it is.
- **The five faults:**
  1. stale ACLs: a sync that stops updating the closure, so a removed user keeps reading;
  2. an embedding version mismatch: a query embedded with a model the index wasn't built with;
  3. the reranker failing open: an error swallowed, so the fused order ships unreranked and nobody notices;
  4. a poison message: an outbox row that fails forever and blocks its partition;
  5. the 2am schedule: an automation whose cron fires in UTC, at the wrong local hour, or twice across a DST change.
- **Each drill:** a symptom, a hidden cause, a check, and the clues a good debugger would follow (logs, the audit table, the queue board).
- **Never against Lucien's real state** unless he runs it himself. Test drills on a test repo and a test database.

**Lane L, air-gapped:**
- **Local chat and embedding models through LM Studio** (OpenAI-compatible, on `:1234`), selected by config. Pick models that are already downloaded in `~/.lmstudio/models` and fit 32 GB. Record how much the golden numbers drop against OpenAI and Cohere with `pnpm eval --retrieval-only` and with the answer eval, on local models.
- **A local reranker on transformers.js:** `AutoModelForSequenceClassification`, then a sigmoid over the logit, never the pipeline API. Its weights are vendored.
- **Egress blocked:** a Compose network with no route out, and a check that the app answers with everything local while outbound calls fail.
- **Vendoring:** the npm store, the images and the model weights, so a machine with no network can install and run.
- **Never call LM Studio for anything Lucien didn't ask for:** start its server only if it isn't running, and say so. Don't download new models without saying which and how big (ask main first if over 5 GB).

## Settled during the build

(Lanes add what they decided here: one bullet per decision, plain words.)

**Wave 1, lane U (the workshop UI)**
- **Where it lives.** `/workshop` (the course's front door, `exercises/README.md`), `/workshop/sections/<id>` (a section's README, with `FINISHED.md` folded under it) and `/workshop/<step>` (a step). Its server code is `src/components/workshop/workshop-server.ts`; the routes are `src/routes/workshop/`, with two server routes under `/workshop/api/` (`run` streams a test run, `jobs/<id>` reports a step switch).
- **Reads in-process, writes through `pnpm ex`.** The pages read the course with `ex`'s own functions (`listSections`, `findStep`, `nextFor`). Every command that changes something or grades it (`start`, `reset`, `solution`, `test`, `diff`) runs as `pnpm --silent ex <command> --json` in a child process, so a switch pauses and restarts the dev server exactly as it does from a terminal. `ex list` took 1.9 s as a child process, too slow for every page.
- **`ex` additions.** `scripts/ex/list.ts` holds `listSections`, `stepRow` and `nextFor`, moved out of `cli.ts` so the app can import them without the whole CLI. `ex list --json` gains `passed` on each step: `status` says `active` for the active step even once it passed. `ex test --progress` reports each test as it ends: with `--json`, one JSON line per event on stderr (`{"event":"collected","nodeids":[...]}`, then `{"event":"test","test":{...}}`), so stdout keeps its one document; without it, a `✓`/`✗` line per test. A Vitest reporter in `vitest-run.ts` writes those events; `runStepTests` takes `onProgress`. The final report still decides the outcome.
- **A switch from the page.** The server function starts `ex` and answers at once, before `ex` pauses this server: the pause waits for open requests, and this one would be among them. The page then polls `/workshop/api/jobs/<id>` with plain `fetch` and counts a 503 or a refused connection as "still switching". The restart drops Vite's socket, so Vite reloads the page once the new server is up; the job id rides in the URL (`?job=`), so the reloaded page picks up the polling and shows the result, then the new active step.
- **One at a time.** One `ex` command that switches or grades runs at a time from the UI (a lock on `globalThis`, so it outlives the restart that reloads the module); a second click gets "still running". `ex` itself has no lock, so a command typed in a terminal at the same moment still races.
- **`--force` only behind a confirm.** When `ex start` refuses to discard playground changes, the page shows `ex`'s own message and detail, with "Discard my changes and start" behind a dialog. "Start over" (`reset`) and "Use the solution" (`solution`) have a dialog each too.
- **Tests stream as server-sent events** over a POST (`text/event-stream`, a comment every 15 s as heartbeat). Closing the page aborts the request, which kills `ex test`'s process group (pnpm, `ex`, Vitest), and only that.
- **Sign-in doesn't go through a slot.** The workshop finds the viewer with the reference code (`src/core/boundary/viewer` and `src/core/acl/tenant`), never `#learn/...`, and its layout doesn't use the chat sidebar (`#learn/frontend/queries`). A half-written step in sections 09, 11 or 12 can't lock the learner out of the page that runs its tests. Dev only: every server function and route refuses outside `acEnv() === "dev"`, and the page says why.
- **The solution diff** needs the step to be active, as `ex diff` does; until then the page says so. It loads only when "Show the solution diff" is pressed.
- **README rendering** reuses the chat's block parser, but keeps links (the README is the repo's own text, not a model's): this app's pages open in the tab, other sites in a new one, repo paths stay as text. A paragraph that opens with a hint's emoji hangs it in a gutter, with its meaning as the label. Hints come from the problem files' `//` comments that open with a legend emoji, indented lines continuing them.

**Wave 1, lane R1 (reference for 18 and 19)**
- **18, claims** (`#learn/eval/claims`): `decomposeClaims(model, { question, answer }, effort)` (structured output `atomic_claims`; a label the answer never cited is dropped), `checkClaims(model, { claims, sources }, effort)` (one call, `claim_checks`: each claim is `supported`, `contradicted` or `not_found` against the sources it cited, or all of them when it cited none, marked `uncited`; a skipped claim is `not_found`; no claims, no call), `scoreClaims` (faithfulness is supported over all claims, 1 for none), `citedLabels`, `DECOMPOSE_INSTRUCTIONS`, `CHECK_INSTRUCTIONS`, the schemas.
- **18, kappa** (`#learn/eval/kappa`, pure maths, its own step): `confusionMatrix`, `observedAgreement`, `chanceAgreement`, `cohensKappa`, `describeKappa` (Landis and Koch's bands). The module's header defines kappa in plain words.
- **18, judge** (`#learn/eval/judge`): `judgeFaithfulness(model, { question, answer, sources }, effort)` (structured output `faithfulness_verdict`, reason before verdict), `JUDGE_INSTRUCTIONS` (faithful is not complete; an old value given as current is unfaithful), `calibrate(items)` (confusion, observed, chance, kappa, disagreements), `renderSources`, `judgeMessage`.
- **The hand labels** are `fixtures/golden/faithfulness.yaml`: 20 answers over the four recorded chat turns (`fixtures/cassettes/generate/`), 8 faithful and 12 not, each with `why`. 5 are recorded replies; the rest are written to test the judge (a wrong number, a claim the sources don't make, the old London limit as current, a faithful rewording, a half answer). `src/core/eval/judge-set.ts` (`loadJudgeSet`) joins each to its turn's question and the 8 sources the model saw, labelled by `buildPrompt`. It reads from disk, so it runs under tsx.
- **A label was wrong, and calibration found it.** `heron-closest` ("none of these documents mention Project Heron") was labelled faithful; the judge and the claim checker both said S2's planted instructions mention the Heron memo. They were right, the label is now unfaithful, and its `why` says so. Worth keeping in the step: disagreements get read both ways.
- **Recordings** (`src/core/eval/recorded.ts`): `fixtures/cassettes/eval/judge.json` (one call per item) and `claims.json` (decompose then check), recorded 2026-10-20 on gpt-6-luna, judge and check at medium, decompose at low. `replayEvalModel(name, itemId)` answers an item's nth call with its nth recording, body ignored; `recordingFetch`, `recordedUsage`, `writeEvalRecording`. `pnpm eval:judge` replays and prints the table and both kappas; `pnpm eval:judge --record` re-records (about $0.014). `src/core/eval/faithfulness.ts` has `judgeItem` and `summarizeFaithfulness`, shared by the script, the tests and the dashboard.
- **18 numbers.** Judge against hand labels: kappa 0.894 (19 of 20, chance 0.53); it called the Heron abstention unfaithful. Claims method (faithful only when every claim is supported): kappa 0.898; it passed "the London limit is £180", since that claim cites S1 (version 1) and only S3 says version 2 replaced it. Checking against cited sources alone can't see a conflict in an uncited one: a good 💯. 2.53 claims per answer (48 over 19 answers with claims); mean claim faithfulness 1.00 on the faithful items, 0.55 on the unfaithful ones.
- **18, agent tasks** (`#learn/eval/agent-tasks`): `AGENT_TASKS` (four: `email-contract-terms` on `kpc-terms`, `recover-from-timeout` on `search-timeout`, `ignore-planted-instructions` on `brightwell`, `delegate-and-compare` on `hotels-compare`), the `Check` union (`finishes`, `calls`, `never-calls`, `plans-before-writing`, `mails`, `mail-says`, `recovers`, `answer-says`, `never-says`, `turns-at-most`), `runCheck(check, events)`, `describeCheck`, `scoreTask` (share of checks passed; passes when all do), `replayTask` (the recording through `drive`, or `driveTree` for the tree), `runAgentTasks`, `summarizeTasks`. All four score 1 on their recordings; a scripted run that follows the Brightwell instructions scores 4/6 and names the two failed checks. No new recordings: the M4 runs suffice. CI runs them as `src/core/eval/agent-tasks.test.ts`; there's no script, since the agent recordings load through `?raw`, which tsx can't.
- **18, the lab's data** (`src/core/eval/dashboard.ts`): `evalDashboard()` gives `golden` (`readGoldenRuns(dir?)`: each `fixtures/golden/reports/*.json`, oldest first: mode, recall@10, MRR, NDCG@10, gates, answers, cost), `faithfulness` (`replayFaithfulness()`: per item results plus the summary) and `agentTasks`. No model, no database. It imports the learnable modules through `#learn/eval/*`.
- **19, config** (`#learn/observability/config`): `telemetryConfig(env)` reads the standard variables: on only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (and `OTEL_SDK_DISABLED` isn't `true`); `OTEL_SERVICE_NAME` (default `agentic-chat`); prompts and replies on spans only with `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`, since they hold tenant documents. `conversationLogFile(env)` reads `CONVERSATION_LOG_FILE`.
- **19, setup** (`#learn/observability/setup`): `createTelemetry(config, parts?)` builds a `NodeTracerProvider` (batched OTLP/HTTP to `<endpoint>/v1/traces`), a `MeterProvider` (periodic OTLP/HTTP to `/v1/metrics`) and the AI SDK integrations, registering nothing; `startTelemetry(config)` registers them once per process (a `globalThis` symbol) and returns null when off. The AI SDK 7 hook is `registerTelemetry()` with `@ai-sdk/otel`'s `OpenTelemetry` (GenAI-convention spans per model call), so `#learn/model/ai-sdk` is untouched. `GenAiSpans` subclasses it to force `recordInputs`/`recordOutputs` from the config: the SDK records them by default. The SDK names a `streamText` call `invoke_agent gpt-6-luna`, with `step 1` and `chat gpt-6-luna` spans inside.
- **19, spans** (`#learn/observability/spans`): `GEN_AI` (the attribute names, as strings: the semconv package marks its gen_ai constants deprecated), `inSpan`, `tracedRetrieve` ("retrieval chunks": returned, rewrites, audit id; `onResult` hook), `tracedTool`/`tracedTools` ("execute_tool <name>", call id, effect; a throw is an error span), `agentStep` ("invoke_agent kestrel-assistant", `gen_ai.agent.id` = run id). A durable run has no single span: it crosses processes, so its steps share the run id. Linking them by a trace context stored on the run row is a 💯.
- **19, metrics** (`#learn/observability/metrics`): `createMetrics(meter)`: `gen_ai.client.token.usage` and `gen_ai.client.operation.duration` (the conventions'), `agentic_chat.model.cached_input_tokens`, `agentic_chat.model.cost`, `agentic_chat.request.duration`, `agentic_chat.request.cost`, `agentic_chat.denials` (kind `acl`, `rate_limit`, `policy`). `modelCallMetrics(metrics)` is a second AI SDK integration, so every chat, rewrite, embedding and rerank call is counted wherever it's made. `recordModelCall`, `recordDenial`, `recordRequest`; `withRequestCost(fn)` and `currentRequestCost()` keep a per-request ledger in `AsyncLocalStorage`. `#learn/observability/request` has `observeRequest(telemetry, { route, attributes, statusOf }, fn)`: span, ledger, latency and cost metrics; a failed request still reports what it spent.
- **19, cost** (`#learn/observability/prices`): `PRICES` (gpt-6-luna $0.10 / $0.01 cached / $0.50 per million; text-embedding-3-small $0.02; Cohere rerank $0.002 a search, a trial key bills nothing), `priceKey`, `costOf` (`priced: false` for a model not in the table, never a silent 0). `pnpm eval` now prices through it (same numbers).
- **19, conversation log** (`#learn/observability/conversation-log`): `enqueueConversationLog(tx, tenantId, { conversationId, replyId })`, `conversationLine`, `exportConversationLog(db, sink, options)`, `conversationLogExporter(db, sink)` (`kick()`, `idle()`), `fileSink`, `Sink`, `CONVERSATION_LOG_KIND`. The row is written in the reply's transaction. It's born published, so the relay (which starts workflows and fails an unknown kind) never picks it up, and the exporter claims it once its line is in the sink (`claimed_by = 'conversation-log'`). Payload ids only; at least once, deduped by reply id. A slow sink (1.5 s) left the chat answering in under a second, line arriving after; a failing sink counts attempts and the next drain exports.
- **App hooks, behind config** (`src/lib/observability.server.ts`): `appTelemetry`, `observedRetrieve` (adds the ACL denial count from the audit row), `observedTools`, `observedLoop` (agent steps), `chatObserver(env, telemetry, exporter)`. Wired in `-deps.ts` (`retrieve`, `observe`), `-chat.ts` (`ChatDeps.observe?`: turn span, 429 denial, log row inside the save transaction, kick after commit; `respond` returns `"complete" | "aborted"`), `agent-tools.ts` and `agent-runtime.ts`. With nothing configured each returns exactly what it was given (`toBe`), `chatObserver` returns undefined, and `startTelemetry` registers nothing; `config.test.ts` and `observability.server.test.ts` check it, and the chat tests pass unchanged.
- **Local stack:** `grafana/otel-lgtm:0.37.0` (Docker Hub, 2026-10-16, the newest) under the `observability` profile: `docker compose --profile observability up -d otel-lgtm`. OTLP on 4317 and 4318; Grafana on **3001** (admin/admin), since the app has 3000. `pnpm otel:sample` replays the four recorded chat turns with telemetry on, no server, database or model; checked: the traces arrived in Tempo (turn, retrieval, the SDK's spans) and the metrics in Prometheus (10,101 input tokens).
- **Packages**, pinned: `@ai-sdk/otel` 1.0.139 (the release that pins `ai` 7.0.139, ours), `@opentelemetry/api` 1.9.1, `sdk-trace-node`, `sdk-metrics`, `resources` 2.12.0, `exporter-trace-otlp-http`, `exporter-metrics-otlp-http` 0.223.0. The 3.0 / 0.300 line came out today; not taken.
- **Cost per request,** recorded turns, answer call only: Brightwell (ella.brooks) $0.000217, invoice hold $0.000542, London hotel $0.000241, Heron $0.000332. A whole turn adds a rewrite and an embedding: the M1 eval's full run averages about $0.00036 a question.
- **Open for the section lane:** the main relay's `deliver` doesn't know `conversation_log` (the born-published row is what keeps it away; teaching it the kind in `relay-deliver.ts` is the alternative). The exporter is only kicked after a chat commit in-process, with no poll: rows left by a crash wait for the next chat. Cohere's production price is an assumption to check.
