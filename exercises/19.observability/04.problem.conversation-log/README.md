---
title: Conversation log fan-out
type: graded
slots:
  observability/conversation-log: conversation-log.ts
---

# Conversation log fan-out

👨‍💼 Kestrel's product team wants every chat turn in their warehouse: what people ask, what came back, which documents it rested on, whether it abstained. The obvious way, writing the line from the chat route, puts the warehouse in every chat's path: when the warehouse is slow, chat is slow, and when it's down, either chat fails or the line is lost. Neither is acceptable. So the chat writes the log as a row in the outbox (section 05), in the same transaction as the reply, and the line goes out later, on the outbox's own time.

## Terms

- A **sink** is where log lines go: `write(lines)` takes a batch. Here, `fileSink` appends to a JSON Lines file (`CONVERSATION_LOG_FILE`); in production, a bucket or a warehouse.
- The **log row** is an outbox row of kind `conversation_log`, partition `conversation:<id>`, payload `{ conversationId, replyId }`: ids only.
- The **relay** (section 05) delivers every unpublished outbox row. For a log row it calls `deliverConversationLog`, which hands the row to the **exporter** and returns at once. A row the relay has handed over is **published**.
- The **exporter** drains log rows in batches: it writes their lines to the sink in one call and **claims** each row (`claimed_by`) once its line is written. `conversationLogExporter` runs its drains in the background; `kick()` starts one.
- **At least once**: a line is never lost, but a crash between the sink write and the claim writes it again. Each line carries its reply id, so a reader keeps the first.

## Do this

🐨 In `playground/conversation-log.ts`, write `enqueueConversationLog` (the row, in the reply's transaction), `exportConversationLog` (one drain) and `deliverConversationLog` (the relay's hand-over). The line itself (`conversationLine`), reading a turn back (`loadTurn`), the select that reads a drain's batch and the background exporter are written: you add the batch's lock, then write, claim and count failures.

With `CONVERSATION_LOG_FILE` set and this step unfinished, chat replies fail to save: the log row and the reply commit together or not at all. That's the promise working.

## A worked example

Ella Brooks asks about the Brightwell launch, replayed from section 10, with a sink that takes 1.5 seconds to write. The chat answers in well under a second and the file is still empty. One relay pass publishes the log row and kicks the exporter; the line lands about 1.5 seconds later. It holds her question, the reply with its two citations (S1 and S3) and none dropped, the 8 sources (all from the onboarding pack), the model and its usage (1,776 tokens in, 79 out). The row ends published by the relay and claimed by `conversation-log`, with 2 attempts: the relay's and the exporter's. The last test runs it through your code. It needs Postgres (`pnpm ex up`).

Run the tests with `pnpm ex test 19.4`.
