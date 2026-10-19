---
title: Fan-out with backpressure
type: graded
slots:
  agent/fanout: fanout.ts
---

# Fan-out with backpressure: the solution

`fanOut` starts `min(limit, items)` **lanes**, each an `async` loop. A lane takes the next index from a shared counter, asks `admit` (unless a refusal already came), and either records `skipped` or runs the item and records `done` or `failed` at that index. Then it takes the next index, until there are none. `Promise.all` waits for the lanes, and the results array is in item order because each result goes to its own index.

## Why it works

- **The limit holds by construction.** There are only `limit` lanes, and a lane runs one child at a time. However children finish, no more than `limit` run at once.
- **A slot refills at once.** A lane takes the next item the moment its child ends. Batches (section 05.5) wait for their slowest child. Page ranges of 250 pages take about the same time each, so that costs little there. Agent runs don't: the two hotel sub-agents of step 3 spent about 9 seconds each on model calls, while a run whose search hangs waits 30 seconds for the timeout alone (section 13.4). In a batch, that one run holds two free slots empty.
- **The counter needs no lock.** JavaScript runs one lane at a time and switches only at an `await`, so `next++` can't hand the same index to two lanes.
- **Admission is backpressure with a brake.** Asking before each start means a kill switch or a spent budget stops everything not yet started, at once, with a reason in the fire's result. Runs already going aren't killed here; their own guard stops them at their next model turn, which is where the kill switch is checked anyway.
- **No timers, so it replays.** The automation workflow's body runs `fanOut`, and Workflow replays that body after a restart (section 15). Which child starts next depends only on which earlier child finished, and each finish is a hook resumed in the log, so the replay starts them in the same order. A `setTimeout` would be reading the clock inside a workflow body.

## Where the limit applies

Per fire. A schedule over a folder is one fire, so its 25 runs go three at a time. A burst of drive changes is one fire per document, so ten documents landing at once start ten fires, each with one run. A limit across fires (per automation, or per owner) would need a shared counter outside the workflow, such as the job queue's class limits in section 05.6. It isn't built: M2's notes list it as open.

## The worked example

Grace's six /Company documents at a limit of 3: three start, the Handbook takes the Code of Conduct's slot the moment it frees, the checklist takes the Calendar's, and once the kill switch is on, the Office Guide is `skipped` with "kill switch: agents are switched off". Peak 3, five done.
