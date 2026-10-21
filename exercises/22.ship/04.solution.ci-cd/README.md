---
title: CI and CD
type: guided
---

# CI and CD: what you built

## The pipeline

```
push or PR ──► CI: lint, format, types, tests (ParadeDB service), build, boot check, gate ──► status "check"
                │
PR ─────────────┼──► Vercel (Git integration): preview at its own URL, Vercel comments on the PR
                │
merge to main ──┴──► CI green ──► Deploy: plan ──► migrate (db:migrate:remote) ──► [deploy, if the CLI shape]
                                                   Vercel (Git integration): production, crons registered
```

The ruleset makes `check` a gate: nothing reaches `main` red, and production is built only from `main`. A preview needs no gate of its own, since it serves nobody but you.

## The two deploy shapes

|                 | Vercel's Git integration (what you set up)          | CI deploys (`deploy.yml` with the `VERCEL_*` secrets)                                                                               |
| --------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Previews        | every push, at once, with a PR comment              | after CI passes, a few minutes later                                                                                                |
| Production      | every push to `main` (already gated by the ruleset) | only after CI passes on `main`                                                                                                      |
| Migration order | races the build; expand and contract covers it      | `deploy` waits for `migrate`                                                                                                        |
| Build           | on Vercel                                           | on the GitHub runner (`vercel build`), uploaded with `--prebuilt`                                                                   |
| Cost            | nothing to maintain                                 | a token in GitHub's secrets, and turning off the Git integration's deploys (`"git": { "deploymentEnabled": false }`) or both deploy |

The gain from the second shape is the order: the migration, then the deploy, never the reverse, and no preview of code that fails its tests. The cost is a long-lived Vercel token in GitHub and slower previews. For a team that can't guarantee expand and contract, the second is safer.

`deploy.yml` only deploys branches of this repo (`head_repository == repository`). A `workflow_run` job runs with the repo's secrets whoever opened the pull request, so a fork's code would otherwise run with the Vercel token and the database URLs.

## The cron jobs

Settings, Cron Jobs, lists `/api/cron/relay`, `/api/cron/scheduler` and `/api/cron/agent-queue` every minute, and `/api/cron/sync` every five. Each call is one bounded pass and returns:

| Route       | One pass                                                        | Bound                                     |
| ----------- | --------------------------------------------------------------- | ----------------------------------------- |
| relay       | `relayOnce` until a batch comes back short, or an outage        | 5 batches of 20 rows                      |
| scheduler   | the schedule slots due now, then runs cancelled outside the app | the slots due this minute                 |
| agent-queue | `workOnce` until no job is due (only with `AGENT_RUNNER=queue`) | 5 jobs, none claimed after 45 s           |
| sync        | a delta sync request per tenant, into the outbox                | one per tenant; skipped with no workspace |

The bounds keep a pass inside one function invocation and under a minute in the common case, so the next minute's call rarely overlaps it. When one does, the passes are safe to run twice: the relay locks rows with `FOR UPDATE SKIP LOCKED` and owns a partition with an advisory lock, a schedule slot fires once whoever claims it first (section 16.4), a job's lease belongs to one worker, and `enqueueSync` skips a tenant whose sync is already waiting. That matters because Vercel says its cron delivery is best effort: a call can be missed, or arrive twice.

Every route answers `401` without `Authorization: Bearer $CRON_SECRET` (compared in constant time), `503` when `CRON_SECRET` isn't set, `405` to anything but `GET`, and `500` with the error when the pass throws (Vercel doesn't retry; the next minute does).

## In an interview

"CI runs lint, types, the tests against a real ParadeDB, the build, a boot check on the built server, and the step gate; a ruleset makes it required on main. Previews come from Vercel per branch; production from main only. Migrations run from CI as the owner, before or alongside the deploy, and stay additive so either order works. Background work is four cron routes, each a bounded, idempotent pass behind a bearer secret, because cron delivery can skip or repeat."
