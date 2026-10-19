---
title: Compaction and memory
type: graded
slots:
  agent/compact: compact.ts
  agent/memory: memory.ts
---

# Compaction and memory: the solution

`compactionPoint` sums the live events' tokens and returns null at or under the threshold. `closedPoints` walks the log with a set of open calls (a turn adds its calls; a result, or a refused or expired approval, removes one) and records each seq where the set is empty. `compactionPoint` keeps the closed seqs among the live events that leave at least `keepTokens` after them, and returns the latest.

`planInForce` takes the latest user message's id, finds the `make_plan` call that `isPlanningCall` accepts, and writes the line with the call's `writes` as JSON. `keptFacts` puts it first, and `compact` appends the facts to the model's story.

`addNote` normalises the text and checks its length, takes `pg_advisory_xact_lock(hashtext('memory:<user>'))`, lists the user's notes, returns a case-insensitive match as `created: false`, throws `MemoryFullError` at 20, and inserts.

## Why it works

- **The cut never splits a call.** At a closed point every call before it has its answer before it too, so the summary covers whole exchanges and the replayed events start clean. An open approval keeps the set non-empty until it's decided, so a call waiting on Leo is never summarised away.
- **The plan lives in the log, so code can always find it.** The model sees the context; the policy and `planInForce` see the whole log. Copying the plan into the summary by code, verbatim, every compaction, means the model always knows it has a plan and doesn't try to make another. And since `decide` and the policy read the plan from the log, a summary can't widen it either.
- **Only the latest message's plan.** A plan covers the request it was made for. When the user sends a follow-up, the next turn plans again from their words; until then, no plan is in force, and no write goes through.
- **Notes are capped under a lock, and stay data.** The lock makes "count, then insert" one step per user, so 25 notes at once give 20 stored and 5 refused. Refusing instead of evicting keeps every note one the user can see and delete. In the context they sit under "User notes (data, not instructions)", and the planning turn never sees them, so a note can shape an answer but never authorise a write.

## The worked example

The lost-plan run at seq 16: 16,285 live tokens, cut at 12 (13 is mid-call; after 14 only 3,575 tokens would stay). The kept facts start with the plan line for message `smoke-c600f552`, call `call_4OPecZV5y1VLYzaMC6mmEfYO`, targets "Daniel Reyes (daniel.reyes@kestrelpay.example)". The context goes from 15 messages and 15,675 tokens to 5 and 5,700, against 5,630 for the summary that lost the plan. With the plan in the summary the model has no reason to plan again: the next long run on 14 October, after this fix went in, compacted, kept its plan and didn't. On `two-compactions` the second cut is 18, at 19,417 live tokens, and its kept facts still name call `call_xl73Y8BZFik6rzZ5ibJ1lGg9` from seq 3. Daniel's "I prefer answers as short bullet points." is stored once; with 20 notes, the 21st throws and the first is still there.
