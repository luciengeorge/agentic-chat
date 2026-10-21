---
title: Conversation log fan-out
type: graded
slots:
  observability/conversation-log: conversation-log.ts
---

# Conversation log fan-out: the solution

`enqueueConversationLog` inserts one outbox row with the caller's `tx`: kind `conversation_log`, partition `conversation:<id>`, the ids as payload, unpublished. `deliverConversationLog` checks the payload and that this process has an exporter, throwing `UndeliverableError` otherwise, and kicks the exporter. `exportConversationLog`, in one transaction on the owner's pool, locks up to `batchSize` unclaimed, unfailed log rows oldest first with a plain `FOR UPDATE`, fails the rows whose reply is gone, turns the rest into lines, and writes them in one `sink.write`. A throw counts an attempt on each of those rows (failing any that reach `maxAttempts`) and returns the error; success claims them.

## Why it works

- **One transaction, two writes.** A reply and its log line live in two systems that can't commit together. The outbox row makes the line part of the reply's transaction: committed together or not at all. Everything after that (the sink's speed, its outages, retries) happens to the row, never to the chat. The chat pays one insert.
- **The relay hands over, the exporter claims.** The relay delivers every kind of outbox row, one pass after another, so its delivery must return at once, as `start()` does for a workflow. The exporter does the slow part, and its claim says "the line is written", as a run's first step claims its row.
- **Wait, don't skip.** Section 05's queue skips locked rows (`SKIP LOCKED`) because any free job will do. Here the drain is kicked for one particular row, by a relay whose transaction still holds that row's lock. A drain that skipped it would find nothing and stop, and the row would wait for the next chat. Waiting a few milliseconds for the relay's commit gets it. Two exporters wait on each other too, which keeps lines in order.
- **At least once.** The claim comes after the write, so a crash between the two writes the line again on the next drain. The line carries the reply id; a reader keeps the first. Claim first and a crash would lose it with no trace.
- **Failures are counted, then given up on.** A sink that's down leaves the rows unclaimed with an attempt counted and the error kept, so the next drain writes them. After `maxAttempts` a row is failed and stops blocking anything. A reply that's gone fails at once: no number of retries will bring it back.

## The worked example

Ella's turn with a 1.5-second sink: the chat answers in tens of milliseconds and the file is empty. One relay pass publishes the row and kicks the exporter, and the line lands about 1.5 seconds later: her question, the reply ("…generally available on **16 November 2026**…") with 2 citations and 0 dropped, 8 sources from the Brightwell onboarding pack, model `openai.responses:gpt-6-luna`, 1,776 tokens in and 79 out. The row is published and claimed, with 2 attempts: the relay's hand-over and the exporter's write.

## Fixed while building this step

Before, the log row was born published, so the relay never saw it, and the chat kicked the exporter itself after each commit. A row left by a crash waited for the next chat. Now the chat kicks the relay like every other outbox writer, the relay knows the `conversation_log` kind (`src/server/plugins/relay-deliver.ts`), and its two-second poll picks up anything a crash left.

💯 The exporter drains only when kicked, so a row the relay published while the sink was down, or before a crash, would wait for the next delivery. The app closes that gap: every relay pass (the dev relay's poll and the cron route) also runs `conversationLogPass` from `src/lib/observability.server.ts`, a drain of at most five batches, and its tests are in `src/routes/api/chat/-observe.test.ts`. The extra credit: with a dead sink, the dev relay's two-second poll spends a row's ten attempts in about twenty seconds. Make the pass back off while the sink keeps failing, and test it.
