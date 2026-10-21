---
title: The overnight digest ran at the wrong time
type: lab
---

# The overnight digest ran at the wrong time

👨‍💼 Tom Whitfield, Kestrel's financial controller:

> I set up the "Overnight payments digest" to run at 02:30. The automations page shows `30 2 * * * (UTC)`, which is what I meant: after the last payment run of the night. Last night it ran at the wrong hour, and the digest missed that payment run. I've paused it. And what will it do on the night the clocks change?

`pnpm ex drill digest` prints the exact time it ran on your machine.

## Plant it

```sh
pnpm ex drill digest
```

Or press **Plant** on this step's page in `/workshop`. It needs ParadeDB, and checks first that it can show the symptom on your machine; it says so if it can't. Clear the dev server's terminal once it's back up.

## See it

Sign in as `tom.whitfield@kestrelpay.example` (password `dev-password`) and open `/automations`: the digest is there, paused, with its schedule. Last night's run is in the database.

## Where to look

- `automation_fires`: the digest's rows, and what each `fire_key` says about when it fired.
- `automations`: its `cron` and `last_fired_at`.
- The scheduler's own maths, from a scratch script: `parseCron` and `nextAfter` in `src/core/automations/cron.ts`. Ask it when `30 2 * * *` fires next, and try a few dates, including 25 October 2026.
- Section 16, step 4 built the schedule; its README says how a slot is found.

🦉 Write down three times: when it should have run, when it ran, and what your machine's clock said. The gap between two of them is usually the clue. Then ask what's different between this laptop and the server the app runs on in production.

## Done when

`pnpm ex drill check` says **fixed**: the code on disk fires `30 2 * * *` at 02:30 UTC, once a day, for the next 400 days on this machine's clock, and the fault's test passes. Then `pnpm ex drill reset`.
