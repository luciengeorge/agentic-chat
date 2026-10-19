---
title: Fan-out with backpressure
type: graded
slots:
  agent/fanout: fanout.ts
---

# Fan-out with backpressure

👨‍💼 Grace's Monday digest over /Company is one fire with one agent run per new document: six this week, up to 25 (`MAX_FIRE_ITEMS`) in a busy one. Each run makes model calls, holds part of her daily budget while each call runs, and holds a database connection. Started all at once, a busy week is 25 runs in the same second. Kestrel runs a fire's runs three at a time, and stops starting them the moment the kill switch is thrown.

## Terms

- **Fan-out** is one job split into many children that run side by side (section 05.5 did it for page ranges).
- A **concurrency limit** is the most children running at once. A fire's is 3 (`AUTOMATION_CONCURRENCY`).
- **Backpressure** is letting what's downstream set the pace: work waits in a queue instead of piling onto a model provider, a budget or a database that can't take it all at once.
- **Admission** is the check before each child starts: is the kill switch off, and is the owner's daily budget not spent?
- A **sliding window** keeps the limit full: whenever one child finishes, the next one starts. **Batches** start `limit` children and wait for all of them before starting more.

## Do this

🐨 In `playground/fanout.ts`, write `fanOut`. The automation workflow calls it with the fire's items, a limit of 3, the kill switch and budget as `admit`, and a `run` that starts one agent run and waits for it.

## A worked example

/Company holds six documents, which a fire lists by path: the 2026 Holiday Calendar, the Brightwell onboarding pack, the Code of Conduct, the Employee Handbook, the new-starter checklist and the Office Guide.

1. The first three start. The other three wait.
2. The Code of Conduct run finishes first. The Handbook starts at once, though the other two are still running. In batches of three, it would wait for both.
3. The Holiday Calendar finishes; the checklist starts.
4. Someone throws the kill switch. When Brightwell's run finishes, the Office Guide is refused before it starts: `skipped`, "kill switch: agents are switched off". The Handbook and checklist runs finish on their own (their guard stops them at their next turn, section 13.6).

Five done, one skipped, never more than three at once. With `Promise.all` instead, all six start together; in a busy week that's 25 planning turns each holding about 6,033 tokens of Grace's budget (her planning turn's hold, section 13.6): 150,825 tokens held in the same second.

Run the tests with `pnpm ex test 16.5`.
