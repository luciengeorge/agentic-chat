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

## Settled during the build

(Lanes add what they decided here: one bullet per decision, plain words.)
