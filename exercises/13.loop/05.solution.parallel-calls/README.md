---
title: Parallel calls
type: graded
slots:
  agent/loop: loop.ts
---

# Parallel calls: the solution

`runTools` maps the calls to `runTool` promises, all started at once, and awaits `Promise.allSettled`. It returns each settled value in the order of `calls`; if any rejected (`RunHalted`, a cancel), it throws that reason once all have settled.

## Why it works

- **Together, because they're independent.** The model asked for the calls in one turn, before seeing any result. Running them at once makes the turn as slow as its slowest call, not the sum.
- **Call order, because the log is the state.** `allSettled` keeps the promises' order, whatever order they settle in. OpenAI pairs results with calls by id and would cope with any order; the log is what needs it. A log that depends on which request won a race isn't reproducible, and section 15's Workflow replays a run from its recorded steps.
- **Settled before thrown.** When a halt stops the run, every call has finished, so nothing the run started is still running once it's marked failed. `Promise.all` would throw at the first rejection with the others still in flight.

## The worked example

The lookup ended at 4,259 ms, the search at 9,349. With `allSettled` the results come back `[search, lookup]` and land at seq 5 and 6, as recorded. Pushing results as they arrive would give `[lookup, search]`, and a replay where the search happened to be fast would give the other order: two runs of the same request, two different logs.
