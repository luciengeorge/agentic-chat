---
title: Automations
type: graded
slots:
  automations/automation: automation.ts
---

# Automations

👨‍💼 Grace wants a digest every Monday morning: "Summarise what's new in /Company for me." Nobody types it; a schedule starts it. That's an **automation**: a prompt that runs as an agent on a trigger, as the user who owns it, so its approvals land in her inbox. Kestrel runs its scheduler on more than one server, and servers restart. Grace must get one digest per Monday, never two and never one for a slot she wasn't due.

## Terms

- A **trigger** says when an automation runs: a `schedule` (a cron expression) or a `drive_change` (a document became ready in a folder).
- A **cron expression** is five fields, minute hour day-of-month month day-of-week, in UTC. `0 9 * * 1` is 09:00 every Monday.
- A **slot** is one time the cron names: 2026-10-19T09:00:00Z is a slot of `0 9 * * 1`.
- A **fire** is one firing of an automation: claim it, then start one agent run per item (one run, or one per document of a folder). Its **fire key** names it: `schedule:<slot>` or `doc:<document>:v<version>`.
- The **scheduler** ticks every 30 seconds in the dev server (`src/server/plugins/scheduler.ts`) and starts a fire's workflow for every slot that's due. **Claiming** a fire inserts `(automation, fire key)` into `automation_fires`; that pair is the table's primary key, so only one insert wins.
- The **owner** is the automation's user. A fire's runs act as them, see only what they can read, and plan from the owner's prompt.

## Do this

🐨 In `playground/automation.ts`, write `dueSlot` (the slot a scheduler should fire now), `dueFire` (that slot as a fire, with its key) and `fireRun` (each run's id and first message).

## A worked example

Grace makes the digest on Monday 12 October at 10:00, after that day's slot. On Monday 19 October two dev servers tick at **09:00:12** and **09:00:27**. Both read the table before either has claimed anything, both find 09:00 due, and both name the fire `schedule:2026-10-19T09:00:00.000Z`. Both start a workflow; the first claim inserts the row and fires, the second hits the primary key and answers `duplicate`. A server restarted at 09:01:40 sees `last_fired_at` at 09:00 and finds nothing due. One digest.

Two more from the same rules. An every-15-minutes schedule on a server down from 09:50 to 11:05 fires 11:00 alone of the four slots it missed. And Monday's digest on a server that was off until Wednesday doesn't fire at all: the slot is more than a day old.

Run the tests with `pnpm ex test 16.4`. The last one needs Postgres (`pnpm ex up`).
