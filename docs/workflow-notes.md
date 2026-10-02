# Workflow notes (M0 spike)

What the M0 spike settled about Vercel Workflow in this app, with the evidence behind each answer. Written on
2026-10-02 against `workflow` 5.0.1, nitro `3.0.260903-beta`, Vite 8.3.2, TanStack Start 1.168 and Node 22.22.

A few terms first. A **run** is one execution of a workflow. The **world** is the backend Workflow keeps runs in: on
your machine that is the **local world**, which writes JSON files to disk and holds its job queue in memory; on Vercel
it is Vercel's world. A **hook** pauses a run until something calls `resumeHook(token, payload)`. A **sleep** pauses
it for a set time. Every run also has a **stream**: steps write to it with `getWritable()`, and anyone can read it
with `getRun(id).getReadable()`.

## Version: `workflow` 5.0.1

`package.json` pins `workflow` and `@workflow/vitest` at `5.0.1`. Every `@workflow/*` package resolves to 5.0.1,
except the few that 5.0.1 itself still pins at 5.0.0 (`utils`, `serde`, `swc-plugin`, `typescript-plugin`). Nothing
is pinned or patched for #4442. One patch exists for another reason: slots (see (b)).

Issue #4442 was about Workflow's step bundle losing the `with { type: "json" }` attribute on JSON imports, so every
local step failed with `ERR_IMPORT_ATTRIBUTE_MISSING`. The fix (PR #4537, merged 2026-09-30) ships in
`@workflow/builders` 5.0.1. The published tarball has `keepImportAttributes: true` in `dist/apply-swc-transform.js`
and `'import-attributes': true` in `dist/base-builder.js`, and it no longer bundles the builder's own
`serde-checker`. The PR says that `serde-checker` was the chain that dragged a JSON import into every app.

One oddity: the runs the previous agent left on 5.0.0 completed with every step on attempt 1, so #4442 did not fire
in this tree on Node 22.22 that day. The PR's trigger is a config file importing a Workflow integration, and
`vitest.config.ts` now imports `@workflow/vitest`. On 5.0.1, steps run in dev, in `pnpm build` and under Vitest. The
previous agent added no workaround for #4442. Its one addition, `src/workflows/start-world.ts`, solves a different
problem (see "Restarting the dev server") and stays.

## The spike

`src/workflows/spike.ts` runs a step (`prepare`), waits on a hook created with `createHook({ token })`, sleeps, then
runs a step (`streamChunks`) that writes three chunks to `getWritable()`, closes the stream and returns
`{ greeting, note, chunks }`.

The routes answer 404 unless `acEnv()` (from `src/lib/env.ts`) says `dev`. A production build settles that when it is
built: with no `AC_ENV` it counts as prod, whatever `NODE_ENV` says when it runs, so the routes are off.
`src/server/production-build.test.ts` and a CI step boot a build with nothing set to check it. Until the M0 review
this line claimed more than the code did: prod detection read `NODE_ENV` at run time, which a bare
`node .output/server/index.mjs` leaves unset, so that server ran as dev and answered on these routes. In dev
the two POST routes also refuse a request whose `Origin` is another site's (403) and a body that isn't JSON (415),
which is what a page elsewhere could send through a plain HTML form.

| Route | Body | Returns |
| --- | --- | --- |
| `POST /api/spike` | `{ sleepMs? }` (0 to 60000, default 2000) | `{ runId, token }` |
| `POST /api/spike/resume` | `{ token, note? }` | `{ runId }`, or 404 `hook not found` |
| `GET /api/spike/:runId` | | `{ runId, status }` |
| `GET /api/spike/:runId/stream` | | the stream as NDJSON (one JSON object per line) |

`start()` returns before the run has registered its hook, so a resume sent straight after the start can get a 404.
Callers retry. Live, the first resume came back 404 and the next one, a few hundred milliseconds later, got 200.

### Live proof (dev server on port 3010)

```
15:23:59 POST /api/spike -> {"runId":"wrun_01M3YKE3NQZ9XP6SEA9GEA2B4A","token":"spike:d8777566-…"}
15:24:00 GET /api/spike/wrun_01M3YKE3… -> {"status":"running"}        (stream reader already attached)
15:24:00 POST /api/spike/resume -> {"runId":"wrun_01M3YKE3…"}
15:24:00 latest event: wait_created                                     (sleeping, 2 s)
15:24:04 GET /api/spike/wrun_01M3YKE3… -> {"status":"completed"}
stream:
{"type":"chunk","index":0,"text":"resumed"}
{"type":"chunk","index":1,"text":"final"}
{"type":"chunk","index":2,"text":"done"}
bad token   -> 404 {"error":"hook not found"}
bad body    -> 400 (zod issues)
unknown run -> 404 {"error":"run not found"}
AC_ENV=test -> 404 on all four routes
```

### Restarting the dev server

A run slept for 15 s. I killed the dev server mid-sleep, waited until after the sleep's deadline, and started it
again. The run carried on and completed. Its event log (`pnpm exec workflow inspect events --runId …`):

```
wait_created    14:59:52.900   due 15:00:07.9; server killed at 15:00:02, restarted at 15:00:21
wait_completed  15:00:26.746
step_created    15:00:26.790   streamChunks
step_completed  15:00:26.826
hook_disposed   15:00:26.830
run_completed   15:00:26.834   output { greeting: "hello step", note: "first", chunks: 3 }
```

A stream reader attached at the moment of the kill got nothing and died with the server. Reading the stream again
after the restart returned all three chunks, because the local world stores chunks on disk. `getReadable({ startIndex })`
resumes from a given chunk.

That recovery comes from `src/workflows/start-world.ts`. The local world's queue lives in memory, so a restart loses
it. Only `world.start()` re-enqueues the pending and running runs it finds on disk. In 5.0.1 nothing in the Nitro or
Vite integration calls it (only the Nest integration and `@workflow/vitest` do), so the Nitro plugin calls
`(await getWorld()).start?.()` at boot. That is the bootstrap shape the 5.0 release notes describe. To check that
the plugin is what saves the run, I repeated the experiment with `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS=0`, which makes
`start()` skip recovery. Run `wrun_01M3YJAPEZPVSH7XMVZSEQQB3B` was still `running` 40 s past its deadline, with
requests reaching the server. With recovery back on, it completed about 5 s after the next boot.

## (a) Does `start()` work from a server route? From a `createServerFn`?

Yes to both.

- **Server route:** every run above.
- **`createServerFn`:** a temporary server function called `start(spikeWorkflow, …)` and returned the run id. I
  called it over the real RPC transport, the way the browser does it: `POST /_serverFn/<id>` with the seroval body,
  `x-tsr-serverFn: true` and same-origin headers. It returned 200 with run `wrun_01M3YJAPEZPVSH7XMVZSEQQB3B`, which
  went on to complete. Without `Origin` or `Sec-Fetch-Site`, TanStack Start's CSRF middleware answers 403. Browsers
  send those headers, so only scripts need to add them.

PLAN.md can drop "`start()` from a `createServerFn` is unverified". Server routes stay the natural home for starts
that hand back a stream.

## (b) Do `#learn/*` imports in workflow and step files go through `learnSlots()`?

Out of the box: not in dev and not under Vitest, only in `pnpm build`. That blocked the course, because the agent
steps in sections 15 and 16 must run the learner's code in the live app. They now do, everywhere, through a small
`pnpm patch` (see "The fix" below).

Workflow does not compile workflow and step code through Vite in dev. `@workflow/nitro` hands every file that has a
directive to `@workflow/builders`, which bundles them with esbuild into `node_modules/.nitro/workflow/steps.mjs` and
`workflows.mjs`. Nitro then loads those files with a native `import()`, outside Vite. esbuild either inlines
`#learn/*` as the reference (what I saw: `steps.mjs` carried `// src/core/_sample/greeting.ts`), or leaves it external
for Node to resolve through `package.json` `imports` (what lane C saw in a scratch copy). Either way the step gets the
reference. `@workflow/vitest` uses the same builder. Only a production build lets Nitro's Vite build bundle
`steps.mjs` again, and that pass runs `learnSlots()`.

**The fix.** No supported hook exists in 5.0.1. Nitro's `ModuleOptions` (what `workflow()` from `workflow/vite`
takes) has `dirs`, `typescriptPlugin`, `runtime`, `sourcemap` and `dashboard`. `@workflow/vitest` takes only paths.
`createBaseBuilderConfig()` drops keys it does not know. `onAfterTransform` can observe a transform but not change it.
Upstream has no issue or PR for an esbuild plugins option. So:

- `patches/@workflow__builders@5.0.1.patch`, registered in `pnpm-workspace.yaml` and explained in its own header,
  adds `appEsbuildPlugins()` to
  `dist/base-builder.js`. It puts the plugins found on `globalThis[Symbol.for("workflow.esbuildPlugins")]` first in
  the two esbuild builds that resolve imports: the steps bundle and the interim workflow bundle. It is one helper and
  two call sites.
- `src/workflows/esbuild-plugins.ts` exports `setWorkflowEsbuildPlugins()`, which sets that global.
- `vite.config.ts` and `vitest.config.ts` call `setWorkflowEsbuildPlugins([learnSlotsEsbuild({ root })])`.
  `learnSlotsEsbuild()` is lane C's esbuild form of `learnSlots()`, sharing `createSlotResolver()`. Both configs load
  in the process that runs the builder, so the global reaches it. Each build sets up the plugin again, so it reads the
  active step at every rebuild and every dev-server restart.

**What would let the patch go:** an esbuild plugin option upstream. That means a `plugins` (or `esbuildPlugins`)
field in `@workflow/builders`' config that reaches the steps and workflow builds, accepted by `workflow()` from
`workflow/vite` (Nitro's `ModuleOptions`) and by `workflow()` from `@workflow/vitest`. When `workflow` is upgraded,
`pnpm install` fails if the patch no longer applies. Then re-make it with `pnpm patch @workflow/builders@<version>`,
or drop it if the option exists by then.

**Evidence.** Each path ran a step that calls `formatGreeting` from `#learn/_sample/greeting`, which step `_smoke.1`
slots. Every case below was run with the patch in place:

| Path | Step `_smoke.1` active | Not active |
| --- | --- | --- |
| dev server (`ex start _smoke.1`, playground holding the problem code) | `formatGreeting("step") isn't written yet`, thrown inside the step | `hello step` |
| dev server, after editing `playground/greeting.ts` to return `playground <name>` | `playground step`, in some orders only (see below) | |
| `@workflow/vitest` (`src/workflows/slots.test.ts`) | `playground step` | `hello step` |
| `pnpm build` | `playground ${name}` in `.output/server` | `hello ${name}` |

Before the patch, the dev server and Vitest rows gave `hello step` with the step active. To check that the test
catches this, I put the unpatched `base-builder.js` from the npm tarball back in place: the playground case failed and
the reference case still passed. With the patched file back, both passed. It also fails if the registration is
removed from `vitest.config.ts`. The dev rows used lane C's real flow: `ex start`
paused the dev server, cancelled open runs, wrote `playground/greeting.ts` and restarted the server. The restart
re-ran Workflow's build (`✓ Compiled workflows`), so `steps.mjs` inlined `// playground/greeting.ts`. So `ex start`
already invalidates Workflow's cached step bundle when slots change. Vitest needs nothing extra, because
`@workflow/vitest` rebuilds its bundles at the start of every run, from the slots active then. `pnpm build` always
builds from scratch.

**Editing a slotted file while the dev server runs.** The second dev row above is not reliable. Lane C repeated it
in another order (`ex solution`, then an edit before the first run), and three runs over 40 s all kept the old code.
Here is why:

- Workflow's Vite transform compiles every file in step mode, so when the app loads `src/workflows/spike.ts` through
  Vite (the route imports it), that copy registers the step bodies too.
- Steps live in one global registry (`Symbol.for("@workflow/core//registeredSteps")`), keyed by step id, and the
  last registration wins.
- The Vite copy registers again on the first request after an edit. `steps.mjs` registers once per Workflow build,
  on the queue's first delivery after it. The hot-update plugin rebuilds `steps.mjs` only when the changed file
  itself has a directive, and a slot file usually has none.

So an edit reaches steps only if `steps.mjs` had already loaded before it. In my run it had, so the fresh Vite copy
won. In lane C's run it hadn't, so the stale `steps.mjs` loaded after the edit and stayed until the next build. The
same rule is why the patch is needed: without it, `steps.mjs` (the reference) loads after the route's Vite copy (the
slot) and wins. `@workflow/nitro` exposes no way to trigger its builder; in Vite mode Nitro's `dev:reload` hook drives
its worker, not Workflow. A restart does rebuild, though (`ex start` showed it). So the fix is for learnSlots to
restart the dev server when a file the active step slots changes, at about a second per save.

Related: the builder scans every `.ts` and `.js` file under the repo root for directives, test files included. Never
put `"use workflow"` or `"use step"` in a test file. Files under `exercises/` and `playground/` that carry directives
get compiled into the app's bundles too.

## (c) Testing hooks, sleeps and retries without real waits

`@workflow/vitest` builds the bundles once per run, then runs workflows in-process against a fresh local world in
each test worker, with no server. `src/workflows/spike.test.ts` gives its run an hour-long sleep and passes in about
400 ms:

```ts
const run = await start(spikeWorkflow, [token, HOUR]);
await waitForHook(run, { token });
await resumeHook(token, { note: "hi" });
const sleepId = await waitForSleep(run);
await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });
expect(await run.returnValue).toEqual({ greeting: "hello step", note: "hi", chunks: 3 });
```

`waitForHook` and `waitForSleep` poll the event log until the run reaches that point. `wakeUp` ends a pending sleep
at once.

**Retries are wall-clock time.** Probes with a throwaway workflow whose step failed on its first attempt:

| Failure | What happened |
| --- | --- |
| a plain `Error` (default retry) | retried and completed; one retry cost 1.4 s |
| `RetryableError` with `retryAfter: "1h"`, then `wakeUp()` | `{ stoppedCount: 0 }`; still waiting 8 s later |
| the same under `vi.useFakeTimers()` and `advanceTimersByTimeAsync(1h)` | still waiting |

The world enforces `retryAfter` itself: `step_started` throws `TooEarlyError`, and the queue redelivers after at
least a second. So tests can count retries and check `FatalError` at about a second per retry. A test that needs
`retryAfter` should pass the delay in as data and use a small value there. The docs add that, without the plugin, a
step is a plain async function you can call directly. I did not verify that here.

**Mocking.** `vi.mock()` cannot reach workflow bodies, and project-local modules are bundled into the steps. Pass
collaborators in as arguments, or feed values in through hooks.

**Config.** `vitest.config.ts` now has two projects. `app` extends the root config and excludes `src/workflows/**`.
`workflows` is standalone (`extends: false`): `@workflow/vitest`, `learnSlots()` and tsconfig paths, the node
environment, `src/workflows/**/*.test.ts` only. Each choice is there for a reason:

- The plugin's setup file loads esbuild, which refuses to run under jsdom (`Invariant violation: "new
  TextEncoder().encode("") instanceof Uint8Array" is incorrectly false`). With the plugin at the root, every jsdom
  test file failed.
- Vitest 5 inline projects extend the root config unless `extends: false` is set, and they concatenate `include`. So
  without it the `workflows` project ran every test in the repo.
- `rootDir: "node_modules/.cache/workflow-vitest"` keeps test runs and bundles out of the dev server's
  `.workflow-data/`. By default they share it, and the local world's source notes that listing runs without a tag
  also lists the test runs' tagged files.
- `AC_WORKFLOW_TEST_ROOT` replaces that rootDir. A Vitest started from inside another Vitest (`slots.test.ts`, and
  `ex test` once it runs workflow tests) needs its own: otherwise it overwrites the parent's bundles, and its test
  worlds clear the parent's run files. The directory has to sit inside the repo, because the builder resolves
  `workflow` from its output directory. A path under /tmp fails with `Can't resolve 'workflow/internal/builtins'`.

**Exercise tests that run workflows** (sections 15 and 16). `ex test` runs a step's tests on the root config, which
has no `@workflow/vitest`. The plan proposed to lane C: such tests are named `*.workflow.test.ts`, and `ex` runs them
with the `workflows` project's plugins and settings, a fresh `AC_WORKFLOW_TEST_ROOT`, and the repo root as `cwd`.
Workflow ids are computed from `process.cwd()`, so another `cwd` gives "workflow not registered". `slots.test.ts`
runs that exact shape.

`pnpm test` runs both projects. `pnpm exec vitest run --project workflows` runs only the workflow tests.

## (d) Where local run state lives, and how to list and cancel open runs

- **Run state:** `.workflow-data/` at the repo root (override with `WORKFLOW_LOCAL_DATA_DIR`). It is disposable
  local state: git and oxfmt both ignore it, and deleting it while the dev server is stopped just forgets every
  local run. It holds `runs/`, `events/`, `steps/`, `hooks/`, `waits/` and `streams/` as JSON, plus `version.txt`. The first 5.0.1
  boot upgraded the 5.0.0 directory in place (`[world-local] Upgrading from version 5.0.0 to 5.0.1`). The queue is
  in memory only.
- **Generated bundles:** `node_modules/.nitro/workflow/`. Test bundles and runs: `node_modules/.cache/workflow-vitest/`.
- **Inspect:** `pnpm exec workflow inspect runs --status running --json`, `inspect events --runId <id>`, or
  `pnpm exec workflow web` for the web UI.

**Cancel for `ex start`.** Lane C's `scripts/ex/switch.ts` uses the CLI:
`workflow inspect runs --status <pending|running> --json --backend local`, then `workflow cancel <id> --backend local`.
That is correct for 5.0.1, and it honours `WORKFLOW_LOCAL_DATA_DIR`. The in-process equivalent is faster (typechecked,
run from the repo root):

```ts
import { getRun } from "workflow/api";
import { getWorld } from "workflow/runtime";

export async function cancelOpenRuns(reason: string): Promise<string[]> {
  const world = await getWorld();
  const open: string[] = [];
  for (const status of ["pending", "running"] as const) {
    let cursor: string | undefined;
    do {
      const page = await world.runs.list({ status, resolveData: "none", pagination: { limit: 100, cursor } });
      open.push(...page.data.map((run) => run.runId));
      cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
    } while (cursor);
  }
  for (const runId of open) await getRun(runId).cancel({ cancelReason: reason });
  return open;
}
```

`getRun(id).cancel()` writes one `run_cancelled` event and sends nothing to the queue, so it needs no running server
and no port. Results:

- From a separate process with the dev server up: 0.3 s for 3 runs, including a 5.0.0 run left over from yesterday.
- With the dev server down: 0.6 s.
- CLI bulk cancel: `pnpm exec workflow cancel --status=running -y`, then `--status=pending -y`. One status per call,
  at most 100 runs per batch, about 1 s each.
- After a cancel, resuming the run's hook returns 404. A run cancelled mid-sleep never woke after its deadline, and
  the next boot's recovery left cancelled runs alone.

The CLI prints `Using default queue target http://localhost:3000`. That is harmless for `inspect` and `cancel`, but
anything that enqueues work from the CLI needs `PORT` set to the dev server's port.

## (e) Pitfalls that apply to us

- **Native modules in steps** (workflow #1003, open). Step code is esbuild-bundled, and native modules such as
  `sharp` fail inside steps on Vercel with TanStack Start. Keep PLAN.md's rule: pure JS or WASM in steps, and native
  work behind a server route. Locally, pnpm skipped the install scripts of `@swc/core`, `esbuild` and `cbor-extract`
  (`pnpm approve-builds`), and Workflow still works, because those packages ship prebuilt binaries.
- **ajv under pnpm** (workflow #3004, open). Every file with a directive goes into one shared steps bundle. So a
  single file that pulls in `ajv`, as `@ai-sdk/workflow` does (`WorkflowAgent`, section 16), breaks every workflow
  with `Dynamic require of "ajv/dist/core.js" is not supported`. The reported workaround is to add `ajv` as a direct
  dependency. Not hit in M0. Retest when `@ai-sdk/workflow` arrives.
- **`fetch` in workflow bodies.** Global `fetch` throws inside `"use workflow"`. Use `fetch` from `workflow`, or make
  the call inside a step. AI SDK calls belong in steps.
- **Determinism.** A workflow body is replayed from its event log, so it must do the same thing every time: no I/O,
  no Node modules, no stream reads or writes (do those in steps), no `setTimeout` (use `sleep`). Changing code under
  an open run can break its replay, which is why `ex start` cancels open runs before it swaps files. One divergent
  replay recovers by itself; repeated ones end in `CORRUPTED_EVENT_LOG`.
- **Two copies of everything a step imports, in dev.** Steps are registered twice, from `steps.mjs` (loaded by
  Node outside Vite) and from the Vite graph, and the last registration wins (see (b)). So a module that steps and
  routes both import (the logger today, a database pool later) is loaded once per graph, and a pool created at module
  scope exists twice. Keep such modules free of start-up side effects that must happen once.
- **One dev server per data directory.** Each dev server has its own in-memory queue, and the boot-time recovery
  re-enqueues every open run to its own port. Two servers on one `.workflow-data/` (say lane A's on 3000 and a test
  server on 3010) can both pick up the same runs. Give a second server its own `WORKFLOW_LOCAL_DATA_DIR`. Inferred
  from the recovery code; during these tests nothing was listening on 3000.
- **Hook tokens route; they don't authorize.** Anyone who can call the resume route can resume the hook, so check
  the caller there. The spike routes are dev-only.
- **Streams sit outside the event log.** A step that writes chunks and then retries writes them again. Call
  `releaseLock()` when another writer may follow, and `close()` only from the last writer, because it ends the
  stream for everyone.
- **Noise.** In dev, Vite warns that it cannot analyse the dynamic imports in `#workflow/webhook.mjs` and
  `#workflow/workflows.mjs`. Those come from `@workflow/nitro` and are harmless. In `pnpm build`, the `@workflow/core`
  chunk in `.output/server` is 4.9 MB (1.4 MB gzipped).

## Open

- Upstream: no issue filed yet asking for the esbuild plugin option described in (b). With it, the patch could go.
- `ex test` running `*.workflow.test.ts` on the `workflows` project is lane C's to build, when sections 15 and 16 need
  it.
- A run already in flight keeps old step code after a slot edit until a request reloads the workflow module (see
  (b)). If a section needs edits to reach a sleeping run, a small Vite plugin could reload the module on slot changes.
