---
title: Background work, done
---

# Background work, done

Kestrel's background work now rests on code you wrote. A job is claimed by one worker only, comes back if that worker dies, and goes dead after five tries instead of failing forever. A failed step retries when time can fix it, after the wait the service asked for, and stops at once when it can't. Every write that asks for a run commits an outbox row beside it, and the relay starts the run, at least once, while the run's first step makes a second start harmless. Two relays never deliver one document's rows at once, and an outage leaves every row as it was. The 3,000-page filing ingests as 12 child runs, ten at a time. And a backfill can no longer hold every worker while a webhook's delta waits.

## What to notice in the lab

Open `/labs/background`, signed in as `leo.martin@kestrelpay.example` (password `dev-password`).

- **The starvation demo**: queue the 12 page ranges, then a delta. With "No cap on backfill", claim: both workers take ranges, and the delta waits at the bottom. Clear, do it again with "Backfill capped at 1": worker B takes the delta ahead of eleven older ranges.
- **The outbox**: every sync you've run is a `sync:<tenant>` row, and every ingest a `document:<id>` row, each "claimed" by the run that took it. Run `pnpm sync` and watch a row go from pending to claimed within a couple of seconds.
- **The run viewer** (the link at the top, which opens `/_workflow`, or `pnpm exec workflow web`): after a full sync, find the filing's ingest run and its 12 `ingestRangeWorkflow` children; a throttled download shows `storeBlob` with two attempts.

## What comes next

Section 06 embeds the chunks these runs write, in the `embedChunks` step you've now seen retry with a `RetryableError`. Section 15 comes back to the queue from step 1: agent runs on it, checkpoint by checkpoint, then the same run as a workflow.
