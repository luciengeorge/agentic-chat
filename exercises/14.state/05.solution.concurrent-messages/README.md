---
title: Concurrent messages
type: graded
slots:
  agent/messages: messages.ts
---

# Concurrent messages: the solution

`appendRetrying` loops: read the run's status and version, call `build` with them (null means return null), and `append` at that version. A `VersionConflictError` sends it round again, up to `MAX_CONFLICT_RETRIES`; any other error goes straight up.

`addMessage` opens a tenant transaction. It answers `not-found` when the run isn't the viewer's, and `duplicate` with the stored seq when `messageSeq` finds the id. Otherwise it appends the `user_message` through `appendRetrying`, with a `build` that returns null for a final run (then `finished`). A unique violation (23505) means the same id was being stored by another request at that moment: it runs the transaction again (three tries in all), and `messageSeq` now finds the first.

## Why it works

- **A conflict means "look again".** Step 2 refuses a writer that read an old run, and doesn't guess. `appendRetrying` is the one place that decides to try again, and it always rebuilds from a fresh read. A user message, a decision or a tool result is still true after someone else got in first; a status move is rebuilt from the status now. A model turn isn't rebuilt this way: it was written without seeing the follow-up, so the runner throws it away and asks the model again.
- **Ordered by the database, not by arrival.** The row lock on the run decides who goes first; each loser appends after whoever beat it. Every write lands once, the seqs have no gaps, and everyone agrees on the order: it's the log.
- **Once, by the client's key.** The client makes the id when Leo presses send, so every retry of that send carries it. The `messageSeq` check answers the usual resend with the first message's seq. The unique index makes it true under a race, where two requests both pass the check before either commits: the second insert fails with 23505, and asking again turns the error into the same `duplicate`.
- **Why not the text.** "Yes." twice is two messages. Only the client knows whether a send is new or a retry, so only the client's id can say it.

## The worked example

From seq 12 (version 10), the approval and the two follow-ups race; the log ends at seq 15 and version 13, each of the three exactly once, in whatever order the row lock gave. The resend of "Copy Amara Okafor too." answers `duplicate` with its seq and stores nothing. The cancel that read `waiting`, beaten by the approval's `waiting -> running`, rebuilds as `running -> cancelled` and lands at version 12. Sent twice at once, one message is stored once: one request answers `added`, the other `duplicate`, both with seq 13.
