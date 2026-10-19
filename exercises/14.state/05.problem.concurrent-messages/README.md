---
title: Concurrent messages
type: graded
slots:
  agent/messages: messages.ts
---

# Concurrent messages

👨‍💼 Leo's run waits on his approval. He approves it in the inbox and, in the same second, sends two follow-ups from the chat: "Copy Amara Okafor too." and "Mention the 30-day terms." Three requests write to one run at once, and step 2's `append` lets only one of them through at a time. The other two get a version conflict. They're Leo's words and his decision: they must land anyway, after the winner. Then his train leaves a tunnel and the browser sends the first follow-up again. That one must store nothing.

## Terms

- **Retrying with a re-read**: after a version conflict, read the run again, decide again what to write, and append at the new version.
- An **idempotency key** is an id made once per action by the client, and sent with every attempt at it. The chat makes a message's id with `crypto.randomUUID()` when Leo presses send (`src/components/chat/chat-view.tsx`), and a retry sends the same id.
- A **unique index** refuses a second row with the same key. `run_events` has one on `(run_id, data->>'messageId')` for user messages. Postgres reports a refusal as error code **23505**.

## Do this

🐨 In `playground/messages.ts`, write `appendRetrying`, which appends what a `build` function makes of the run as it is now, reading and building again after each conflict; and `addMessage`, which adds a user message once per message id. `messageSeq` (find a message by its id), `ownStatus` (the run's status, if it's the viewer's) and `pgCode` are written.

🚨 The classic mistake is retrying a stale write without re-reading: the same events at the same version (it never lands) or at the next one (its `from` is stale, and step 1 refuses it). The other is a key made per attempt, such as `Date.now()`: then a resend is a new message.

## A worked example

Leo's run at seq 12: `waiting`, version 10. The approval and both follow-ups read version 10 and race. One wins seq 13 at version 11; the two that lose read again and land at 14 and 15, at versions 12 and 13. Which is which depends on who got the row first, but the log is always 1 to 15, each write once. The browser's resend of "Copy Amara Okafor too." then finds its id at 13, 14 or 15 and answers `duplicate` with that seq, and the log stays at 15.

In the same spot, Leo cancels while the approval resumes the run. The cancel built `waiting -> cancelled`, but by the time it writes, the run is `running`. It conflicts, reads `running`, and builds `running -> cancelled`, which lands at version 12.

Run the tests with `pnpm ex test 14.5`. They need Postgres (`pnpm ex up`).
