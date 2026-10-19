---
title: Automations
type: graded
slots:
  automations/automation: automation.ts
---

# Automations: the solution

`dueSlot` parses the cron, sets the window's start to the latest of `createdAt`, `lastFiredAt` and `now` less 24 hours, and returns `latestSlot(cron, start, now)`: the latest slot after the start, up to and including `now`, or null. `dueFire` wraps that slot as `{ fireKey: scheduleFireKey(slot), firedAt: slot }`. `fireRun` names the run `uuidv5("<automation>:<fire key>:<document id or ->", RUN_NAMESPACE)` and gives it `runMessage(prompt, documentId)`.

## Why it works

- **The key is something every scheduler agrees on.** The slot is a fact about the cron, the same for a scheduler that ticks at 09:00:12, one at 09:00:27 and one that restarts at 09:01:40. `claimFire` inserts `(automation, fire key)` with `ON CONFLICT DO NOTHING`, under a lock on the automation's row, and only the insert that lands gets the work. A key made from the tick's time would give each scheduler its own key, and each would win its own claim. Drive changes use the same idea with the document's version: ingest finishing twice for version 3 makes one key.
- **That's at-most-once by name.** This is the same trick as section 15's idempotency keys: you can't stop two processes from trying, so you make their attempts collide on a key and let the database keep one.
- **The window keeps one scheduler honest.** Starting after `lastFiredAt` means a slot already claimed is never due again. Starting after `createdAt` means a new automation never fires a slot from before it existed. Starting no earlier than a day ago drops stale slots. Taking only the latest slot means a server that was down fires once, however many slots it missed.
- **The run's id is a key too.** The fire's workflow makes each run in a step, and a step can run twice. A name made from the automation, the fire and the document gives the same run id the second time, so `startRun` finds the run instead of making another.
- **A run hears ids, never filenames.** The run's first message is what its plan is made from (section 17). Its owner wrote the prompt, but a document's title was written by whoever named the file. So the message carries the id, and the run reads the title with `read_document`, as tool output that can't plan a write. And `claimFire` lists only documents the owner can read (the SQL `readable`), so a fire never even names a document its owner couldn't open. The red-team scenario `automation-document-title` is this attack.

## The worked example

The test runs Grace's `0 9 * * 1` on a real database: two `dueScheduleFires` at 09:00:12 and 09:00:27 both return `schedule:2026-10-19T09:00:00.000Z`, two `claimFire`s at once give one `fire` and one `duplicate`, and a tick at 09:01:40 returns nothing. `automation_fires` holds one row.

## When it runs where

In dev, the scheduler is a loop in the dev server, ticking every 30 seconds. On Vercel there's no long-running process to hold a loop, so section 22 replaces it with a cron route that Vercel calls on a schedule. The fire's code doesn't change: whoever calls it, as often as they like, the key lets one fire through.
