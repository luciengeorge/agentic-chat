---
title: Ship it, done
---

# Ship it, done

Kestrel's assistant now runs where Kestrel can reach it. The app and its workflows are on Vercel, in London, next to a ParadeDB on a Fly Machine with the same image, the same migrations and the same `ac_app` role as your laptop. The server won't start without its eight variables and names any that's missing. The four loops `pnpm dev` ran are cron routes, one bounded pass each, behind a secret. The copied people have a password only you know. And every change reaches production through CI, the gate and a migration first.

## What to look at

- **The production deployment's logs**, filtered to `/api/cron/relay`: one `cron pass` line a minute (once a day on Hobby), `published: 0` while nothing writes to the outbox.
- **The Workflows page**: the runs from step 3, each step a separate invocation, and the hook each one waited on.
- **A boot that fails on purpose.** Remove `CRON_SECRET` from a preview's variables and redeploy: the logs name it, and every page fails until it's back.
- **Fly's dashboard**: the Machine's memory and CPU at rest, and the volume's daily snapshots.

## What's still open

- **Hobby's daily crons.** Per-minute schedules need Pro ($20 a month). On Hobby, a GitHub Actions schedule calling the cron routes with the secret every five minutes is a free stand-in, at GitHub's best-effort timing.
- **No workspace in the cloud.** fake-workspace isn't deployed, so there's no sync, no ingest and no mail; the documents are a copy. A real tenant would set `FAKE_WORKSPACE_URL` to their Graph endpoint and a `WORKSPACE_TOKEN_<SLUG>` each, and the sync cron would start.
- **The kick in production.** A request that writes an outbox row wakes nothing on Vercel, so the row waits up to a minute. Running one relay pass in that request, after commit, would close the gap.
- **Connections.** Each function instance holds up to 20 connections; at scale, a pooler (PgBouncer) goes in front of Postgres.
- **Observability.** Section 19's telemetry turns on with `OTEL_EXPORTER_OTLP_ENDPOINT`: Grafana Cloud's OTLP endpoint and token, as two more variables, would show the same traces and metrics from production.
- **A production build run locally** logs `world start failed: Invalid version string: "bundled"` at boot (the local world's recovery, in `start-world.ts`); runs still work there, and on Vercel the plugin doesn't run.

## What comes next

Nothing: this was the last section. You've built every layer of the assistant by hand and shipped it. The interview answer is the whole system now, from a PDF's text layer to a cron route on Vercel, with a number from this corpus for each part.
