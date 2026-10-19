---
title: Parallel calls
type: graded
slots:
  agent/loop: loop.ts
---

# Parallel calls

👨‍💼 Grace's second turn asks for two things at once: `search_documents` for the contract, and `find_person` for Tom. The search took 5.1 seconds, the lookup 7 milliseconds. Neither needs the other, so they should run together. And whichever finishes first, the log must come out the same.

## Terms

- **Parallel calls** are the calls of one turn: the model asked for them together, before seeing any result, so none depends on another.
- **`Promise.allSettled`** waits for every promise and reports each one's result or error, in the order the promises were given.
- **Call order** is the order the model asked for its calls. **Completion order** is the order they finished in.
- **Deterministic** means the same run gives the same log every time.

## Do this

🐨 In `playground/loop.ts`, write `runTools`: run a turn's calls at once through `runTool`, and return their results in call order.

## A worked example

Grace's turn 2, from the recording. `search_documents` started 4,227 ms into the run and ended at 9,349: an embedding, two searches and a Cohere rerank, 5,122 ms. `find_person` started 25 ms later, at 4,252, and ended at 4,259: one SQL query, 7 ms. The lookup was done 5.1 seconds before the search.

The log still says: seq 5, the search's result; seq 6, the lookup's. That's the order the model asked in. The turn took 5,122 ms, the slower call's time.

Run the tests with `pnpm ex test 13.5`.
