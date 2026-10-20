---
title: The overnight digest ran at the wrong time
type: lab
---

# The overnight digest ran at the wrong time: the solution

**The cause.** `nextAfter` in `src/core/automations/cron.ts` tests the hour with `t.getHours()`, the server's local time, where every other field uses UTC (`getUTCMonth`, `getUTCDate`, `getUTCMinutes`, and `setUTCHours` to move on). On a server that isn't on UTC, a schedule fires at that hour of local time. On a machine in Paris in October (summer time, UTC+2), "02:30" comes round at 00:30 UTC, two hours early. Production runs on Vercel, whose clock is UTC, so there it looks right, and only a laptop shows it.

## The path a good debugger takes

1. **Three times.** Meant: 02:30 UTC (the page and the schema both say UTC). Ran: the time `ex` printed, from the fire key in `automation_fires` (for example `schedule:2026-10-20T00:30:00.000Z`, on a Paris machine). The machine's clock: 02:30 local is 00:30 UTC. The gap between meant and ran is exactly the machine's offset from UTC, which rules out a slow queue or a late worker (those would be late by minutes, not early by whole hours).
2. **Is it the data or the code?** The cron string is right, `30 2 * * *`, and `last_fired_at` matches the fire. So the schedule is stored right and computed wrong.
3. **Run the scheduler's maths.** From a scratch script, `nextAfter(parseCron("30 2 * * *"), new Date())` gives 00:30 UTC tomorrow. With `TZ=UTC` in front of the command, it gives 02:30 UTC. The same code, two answers, decided by the machine's time zone: something in it reads local time.
4. **Look for the call that isn't like the others.** In `nextAfter`, every check is `getUTC...` except the hour's, `getHours()`.

## The fix

```ts
} else if (!cron.hours.has(t.getUTCHours())) {
```

Restart `pnpm dev` (the scheduler is a server plugin). The check runs the code on disk for 400 days on this machine's clock and expects one fire a day at 02:30 UTC; the fault's test runs it under Paris, London, New York and UTC, across both clock changes.

## Tom's second question: the night the clocks change

With the fault, on a Paris machine, `30 2 * * *` fires when the local clock reads 02:30:

- **25 October 2026, clocks go back** (03:00 summer time becomes 02:00 winter time): 02:00 to 02:59 happens twice, so the digest fires twice, at 00:30 and 01:30 UTC.
- **29 March 2026, clocks go forward** (02:00 becomes 03:00): 02:30 never happens, so it doesn't fire that night at all.

With the fix it fires once a night at 02:30 UTC, every night of the year; the local time it lands on moves by an hour twice a year, which is what a UTC schedule means, and what the page says.

## The lesson

- **Keep time in UTC, everywhere, and convert only to show it.** One local call in a UTC calculation is enough to break it, and only on machines off UTC.
- **Test with the time zone set.** `TZ=Europe/Paris` and `TZ=America/New_York` in a test, across both clock changes, catch what a UTC CI runner never will.
- **Daylight saving is where schedules go wrong.** A local time can happen twice or not at all. A schedule in local time needs a rule for both nights; a schedule in UTC avoids the question.
