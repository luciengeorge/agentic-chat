---
title: The app and workflows to Vercel
type: guided
---

# The app and workflows to Vercel

👨‍💼 Kestrel's assistant has only ever answered on `localhost`. Before anyone at Kestrel can use it, it needs a home that builds it from the repo, serves it over HTTPS, and runs its workflows without a laptop staying awake. That's Vercel. First, see exactly what Vercel will run, then link a project and deploy once, with no secrets yet, to watch the server refuse.

## Terms

- **Build output** is what a build leaves for the host to run. Nitro, the server under TanStack Start, writes Vercel's format when it sees Vercel: `.vercel/output/`, with static files and one folder per function.
- **Workflow's Vercel world.** Locally, Workflow keeps runs as files and its queue in memory (the local world). On Vercel, Vercel stores the runs, and **Vercel Queues** (a message queue) delivers each step to a function of its own.
- **Fluid compute** is how Vercel runs functions now: one instance serves many requests at once and stays warm between them. A request may run for up to 300 seconds on Hobby and Pro by default.

## Do this

1. 🐨 Build what Vercel builds, on your machine. On Vercel, Nitro picks this preset by itself; here `NITRO_PRESET=vercel` asks for it.
   ```sh
   NITRO_PRESET=vercel pnpm build
   du -sh .vercel/output/functions/*.func .vercel/output/functions/.well-known/workflow/v1/*.func
   cat .vercel/output/functions/.well-known/workflow/v1/flow.func/.vc-config.json
   ```
   You should see three functions: `__server.func` (the app, about 119 MB), `.well-known/workflow/v1/flow.func` (the workflow and step runner, about 111 MB) and `webhook/[token].func`. The flow function's config has a `queue/v2beta` trigger: Vercel Queues calls it, and no browser ever does.
2. 🐨 Now the same build with local models in it (section 21), and compare.
   ```sh
   LOCAL_BUILD=1 NITRO_PRESET=vercel pnpm build
   du -sh .vercel/output/functions/__server.func .vercel/output/functions/__server.func/node_modules/onnxruntime-node
   rm -rf .vercel/output
   ```
   Write down both sizes. Vercel's limit for a function is 250 MB uncompressed. Which build fits?
3. 🐨 Check your Vercel plan (dashboard, **Settings**, **Billing**). `vercel.json` schedules three cron routes every minute. Hobby allows one run a day per cron job, and refuses a deploy whose schedule runs more often. On Hobby, change each `"* * * * *"` and `"*/5 * * * *"` in `vercel.json` to a daily time such as `"0 3 * * *"` before you deploy, and read step 4 for what that costs you.
4. 🐨 Log in and link the repo to a new Vercel project. Accept the detected settings (TanStack Start, `pnpm build`).
   ```sh
   vercel login
   vercel link
   ```
   `vercel link` writes `.vercel/project.json` (git-ignored): the ids of your team (`orgId`) and project (`projectId`).
5. 🐨 In the dashboard, open the project's **Settings**. Under **Build and Deployment**, set **Node.js Version** to 22.x, the version the repo is built and tested on. Under **Functions**, set **Function Region** to London (`lhr1`): step 2 puts the database there too.
6. 🐨 Deploy a preview, with no environment variables set yet.
   ```sh
   vercel deploy
   ```
   It prints the preview's URL. Open it (Vercel asks you to sign in: previews are protected by default). You get Vercel's error page, `FUNCTION_INVOCATION_FAILED`. Open the deployment in the dashboard, then **Logs**, and find the server's own message.

🦉 Why the server refuses instead of starting and failing later. A Nitro plugin, `refuse-dev-secrets.ts`, runs before the first request and calls `assertProdEnv` (`src/lib/env-check.ts`). A missing `DATABASE_URL` found at boot is one clear line in the logs. Found later, it's a 500 on the first chat, a cron route that crashes every minute, or an agent run that dies at its first database step, each with a different stack trace. The check names every missing variable at once, so one redeploy fixes them all.

📜 [Vercel Functions limits](https://vercel.com/docs/functions/limitations), [Cron Jobs usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Nitro on Vercel](https://nitro.build/deploy/providers/vercel)

When you're done: the preview exists and its logs list what's missing. Step 2 provides it.
