---
title: Hooks and streams on a Vercel preview
type: guided
---

# Hooks and streams on a Vercel preview: what you saw

## The checklist's output

From the rehearsal (the production build on :3021 over a copied database, 21 October 2026), with `SMOKE_CRON_SECRET` set:

```
ok   serving  GET / 200 with 4 security headers; /api/me 401 signed out
ok   dev-only routes off  POST /api/spike 404
ok   cron routes refuse strangers  4 routes: 401 without the secret and with a wrong one
ok   cron passes  relay {"batches":1,"published":0,"retried":[],"failed":[],"outage":false} in 46 ms; scheduler {"fired":0,"reconciled":[]} in 2 ms; agent-queue {"skipped":"AGENT_RUNNER isn't queue"} in 0 ms; sync {"skipped":"no workspace is configured (FAKE_WORKSPACE_URL)"} in 1 ms
ok   sign in and /api/me  leo.martin -> kestrel, nina.osei -> harbour
ok   banned user refused  peter.hall: 403 BANNED_USER
ok   answer  leo.martin: "expenses-meals" cited /HR/Policies/Travel and Expenses Policy v2.pdf p2 (3 citations, 0 dropped); "heron-intern" abstained from 8 sources, none in /Exec
ok   hooks and streams  run b7e27afc-…: 1 rejection(s) (1 decided), succeeded; run dead68a7-…: cancelled while waiting
```

Each line checks one thing a deploy can get wrong:

| Check                        | What it would catch                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| serving                      | the app not answering, or a proxy stripping HSTS, CSP or `X-Frame-Options`; Vercel's sign-in page in front, with a hint about the bypass secret |
| dev-only routes off          | a deploy with `AC_ENV=dev` set by mistake, which would open the spike routes and the labs that show other people's access                       |
| cron routes refuse strangers | a missing `CRON_SECRET` (the route answers 503), or a check that lets the wrong one through                                                     |
| cron passes                  | a pass that can't reach the database with the owner's URL, or throws                                                                            |
| sign in, banned              | a wrong `BETTER_AUTH_URL` (sign-in refused as "invalid origin"), the copy missing people, a ban lost                                            |
| answer                       | the chat's stream through Vercel's proxy, the keys, the search over the copied chunks, the ACL keeping the intern out of /Exec                  |
| hooks and streams            | two agent runs through Workflow: one waits on its approval hook, is rejected, and finishes; the other is cancelled while it waits               |

The smoke rejects and cancels; it never approves, because approved mail would go to fake-workspace. So it proves the hook resumes and the cancel lands without sending anything.

## What differs from the local world

- **Where runs live.** Locally: JSON files in `.workflow-data/`, a queue in the dev server's memory, and `start-world.ts` re-queuing open runs at boot. On Vercel: Vercel's store and Vercel Queues; `start-world.ts` does nothing there (it returns when `VERCEL` is set), since nothing needs re-queuing after a restart.
- **Where steps run.** Locally, in the dev server's process. On Vercel, each step in an invocation of `flow.func`, possibly a different instance each time. So nothing a step leaves in memory is there for the next one. Passing ids, never objects, between steps (PLAN.md's state rule) is what makes this safe.
- **Hooks.** The approval route calls `resumeHook(token, payload)`; on Vercel the token is looked up in Vercel's store, and the run's next step is queued. `start()` still returns before the run has made its hook, so a resume sent at once can get "hook not found", as in the M0 spike; the app's approval card only exists once the run asked.
- **Streams.** The local world writes stream chunks to disk; Vercel stores them. Either way a reader can come back with a start index, which is how your reload in step 5 got every event again.
- **The kick.** `kickRelay()` dispatches an event inside one process. On Vercel the request that wrote an outbox row and the relay are different functions, so no loop hears it. Instead the relay plugin, on Vercel, answers each kick with one relay pass in the same function, handed to `waitUntil` (from `@vercel/functions`) so it runs after the response has gone and the function stays up until it ends. A row reaches its workflow within the request's own lifetime; one the pass misses waits for the minute's cron.
- **Time limits.** A function may run 300 s. A chat stream is far shorter. A run's SSE stream can outlast it; when it's cut, the browser reconnects with `Last-Event-ID` and carries on, so the limit shows up only as a reconnect.

## In an interview

"Durable execution behaves the same in tests and on Vercel only if the two worlds keep the same contract, so we check the contract where it runs: a smoke against every preview that signs in, streams an answer, and drives two agent runs through their approval hook, one rejected and one cancelled while it waits. Steps pass only ids, because on Vercel each step can run in a different instance. And anything that was a background loop locally is a cron route, guarded by a bearer secret, doing one bounded pass."
