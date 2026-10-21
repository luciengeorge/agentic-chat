---
title: The app and workflows to Vercel
type: guided
---

# The app and workflows to Vercel: what you saw

## The build, measured (21 October 2026)

| Build                                   | `__server.func` | `flow.func` | Fits Vercel's 250 MB? |
| --------------------------------------- | --------------- | ----------- | --------------------- |
| `NITRO_PRESET=vercel pnpm build`        | 119 MB          | 111 MB      | Yes                   |
| `LOCAL_BUILD=1 NITRO_PRESET=vercel ...` | 450 MB          | 434 MB      | No                    |

Of the local build's 450 MB, 294 MB is `onnxruntime-node`, the native engine the local reranker runs on, shipped with binaries for five platforms. The hosted build never loads it: with `MODEL_PROVIDER` unset the reranker is Cohere, over HTTPS. So section 21's Vite plugin swaps `@huggingface/transformers` for a module that throws "this build has no local models", and the 294 MB stays out. Vercel does have "large functions" (up to 5 GB, in beta), but every cold start would then load 450 MB to serve code that never runs.

The `flow.func` function is how Workflow runs on Vercel. A workflow function and its steps don't run inside the request that called `start()`. `start()` writes the run and puts a message on Vercel Queues; the queue calls `flow.func`, which replays the run from its event log, runs the next step, records the result, and queues the next message. That's the same event log you read in section 15, kept by Vercel instead of in `.workflow-data/`.

## Why each setting

- **Node.js 22.x.** CI tests on 22, and Nitro picks the function's runtime from the build's Node version (`nodejs22.x` in `.vc-config.json`). A different major version on Vercel is an untested runtime.
- **London, for functions and the database.** A chat turn makes several database round trips: the session, the rate limit, the search, the audit row, the saved reply. From `iad1` to a database in London each trip takes roughly 75 ms; within one region, about 1 ms. Five trips add almost 0.4 s to every answer before the model even starts.
- **The cron plan.** `vercel.json` is where the cron jobs live: Vercel's build reads its `crons` and adds them to the deployment (the Vercel CLI's `mergeCrons`, read in v64.7.0). On Hobby, a schedule more often than daily fails the deploy with "Hobby accounts are limited to daily cron jobs". On Hobby with daily schedules, the relay drains the outbox once a day. On this deploy that's tolerable, because nothing writes to the outbox: there's no workspace to sync and the conversation log is off. A real tenant's sync could not wait a day.

## What the logs showed

```
Error: The server can't start in prod without these (see .env.example):
  DATABASE_URL: the app role on the cloud database: postgres://ac_app:<password>@<host>:5432/ac
  DATABASE_ADMIN_URL: the database's owner, for migrations and the cron routes' cross-tenant work
  BETTER_AUTH_SECRET: openssl rand -hex 32
  BETTER_AUTH_URL: this deployment's own origin, e.g. https://agentic-chat.vercel.app
  TOAST_SECRET: openssl rand -hex 32
  CRON_SECRET: openssl rand -hex 32; Vercel sends it to the cron routes
  OPENAI_API_KEY: platform.openai.com, API keys
  COHERE_API_KEY: dashboard.cohere.com, API keys
```

A preview runs as prod: a production build with no `AC_ENV` is prod (section 11), so the dev-only labs and the spike routes are off, and the boot check applies. Once these are set and the secrets are real, `assertSafeSecrets` still refuses the public dev values of `BETTER_AUTH_SECRET` and `TOAST_SECRET`, and `assertProdEnv` refuses the dev `CRON_SECRET`.

## In an interview

"The app is serverless, so anything that ran as a loop in dev becomes either a cron route or a queue consumer. Durable work goes through Workflow, which on Vercel is a queue-triggered function that replays each run from its event log, one step per invocation. The server checks its environment at boot and names everything missing, so a bad deploy fails with one log line before any user sees it. We keep native, local-only dependencies out of the hosted bundle: onnxruntime alone would have taken the function from 119 to 450 MB, past the 250 MB limit."
