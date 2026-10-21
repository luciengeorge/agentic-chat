---
title: Hooks and streams on a Vercel preview
type: guided
---

# Hooks and streams on a Vercel preview

👨‍💼 Every test of Kestrel's agent ran against Workflow's local world: runs as files, a queue in memory, one process. Kestrel's approvals wait on hooks for days, and its run timelines follow streams across reloads. On Vercel, both go through services the laptop never touched. Before production carries a real approval, a preview should prove both work there.

## Terms

- A **hook** pauses a run until someone resumes it with its token: here, the approval inbox's button (section 15).
- A run's **stream** is what its steps write with `getWritable()`: tokens and step events, read back by the browser and resumable from a position (section 12's `Last-Event-ID`).
- **Deployment Protection** puts Vercel's sign-in in front of previews. **Protection Bypass for Automation** is a secret that lets a script through, sent as the `x-vercel-protection-bypass` header.
- An **alias** is a second, stable URL for a deployment.

## Do this

1. 🐨 Give previews a stable address, since sign-in only trusts the origin in `BETTER_AUTH_URL`. Pick a free name, then add both variables for **Preview** (press enter when asked for a branch, to cover them all):
   ```sh
   export PREVIEW=kestrel-preview-<you>.vercel.app
   vercel env add BETTER_AUTH_URL preview    # https://kestrel-preview-<you>.vercel.app
   vercel env add VITE_SITE_URL preview      # the same
   ```
2. 🐨 Deploy a preview and alias it.
   ```sh
   url=$(vercel deploy) && vercel alias set "$url" "$PREVIEW"
   ```
3. 🐨 In the dashboard, **Settings**, **Deployment Protection**, add a **Protection Bypass for Automation** secret. Then run the checklist against the preview. `SMOKE_PASSWORD` is the password you gave everyone in step 2.
   ```sh
   export VERCEL_AUTOMATION_BYPASS_SECRET=<the bypass secret>
   read -rs SMOKE_PASSWORD && export SMOKE_PASSWORD
   pnpm ex smoke --target "https://$PREVIEW"
   ```
   Eight lines, each `ok`: serving, dev-only routes off, cron routes refuse strangers, cron passes (skipped), sign in, banned user refused, answer, hooks and streams. The last two call OpenAI and Cohere: a few tenths of a cent.
4. 🐨 Run the cron passes once by hand. Vercel Cron only calls production, but the routes exist on a preview too.
   ```sh
   read -rs SMOKE_CRON_SECRET && export SMOKE_CRON_SECRET   # the preview's CRON_SECRET
   pnpm ex smoke --target "https://$PREVIEW"
   ```
   Now "cron passes" reports each route: the relay's batches, the scheduler's fires, the queue and the sync skipped, each with why.
5. 🐨 By hand, in a browser, on `https://$PREVIEW`: sign in as `tom.whitfield@kestrelpay.example`, turn on **Run as agent**, and ask "Email Leo Martin (leo.martin@kestrelpay.example) one line saying hello from the preview." When the approval card appears, **reload the page**. The timeline comes back with every event so far. Then **Reject** it, and watch the run finish without sending.
6. 🐨 Open the project's **Workflows** page in the dashboard and find that run: its steps, the hook it waited on, and when the rejection resumed it.

Don't approve a mail on the deploy: mail goes through fake-workspace, which isn't deployed, so the step fails at once ("WORKSPACE_TOKEN_KESTREL must be set").

🦉 Why test this on a preview at all, when every workflow test passed. The tests ran Workflow's local world, and the local world is a different implementation of the same interface: a hook's token is looked up in files there, and in Vercel's store here; a step runs in the same process there, and in a separate function invocation, delivered by a queue, here. Anything a step kept in memory (a module variable, a cache on `globalThis`) is gone by the next step. Hooks route, streams resume and steps retry the same way only if both worlds keep the contract, and the only way to know is to run it.

📜 [Vercel Workflow](https://vercel.com/docs/workflows), [Deployment Protection](https://vercel.com/docs/deployment-protection)

When you're done: eight `ok`s, a run that survived a reload, and its trace in Vercel's Workflows page.
