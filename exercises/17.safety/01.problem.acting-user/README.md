---
title: Authorisation as the acting user
type: graded
slots:
  agent/tools/send-mail: send-mail.ts
  agent/tools/share-document: share-document.ts
---

# Authorisation as the acting user

👨‍💼 Grace's agent finds documents by searching, and search only shows her what she can read. But the model writes the document ids in a `send_mail` call itself, and it can write any id: one it read in a document, one from an earlier turn, one it made up. So the tool can't trust where an id came from. Before anything leaves, it asks Postgres whether Grace can read every document the call touches.

## Terms

- The **acting user** is `ctx.viewer`: the person the run works for. The agent has no access of its own.
- **`canRead`** (section 09) is the one place access is decided: Postgres, the document's ACL, the user's groups. `readableDocument(tx, userId, id)` wraps it and returns the document, or null.
- A **drive item id** is fake-workspace's id for a file: the document's `externalId`.
- A **confused deputy** is a program with more power than the person it acts for, tricked into using that power on their behalf. It's the interview name for what this step stops: the agent's tools reach every drive, so they must check what the user can do, never what the tool can.
- **`X-Acting-User`** is the header the writer sends with an invite. It names the user the invite is made for, and fake-workspace checks that user can read the item too.
- An **idempotency key** (`ctx.idempotencyKey`, `agent:<run>:<call>`) makes a retried call happen once.

## Do this

🐨 In `playground/send-mail.ts` and `playground/share-document.ts`, write each tool's `execute`: check as the acting user, then send or share through the workspace writer.

## A worked example

Grace can read 18 of Kestrel's 40 documents. The Q3 2026 quarterly report is one; the Project Heron board memo, in `/Exec`, isn't. Her mail to Tom attaching the report goes out from her, with the report's drive item and the key `agent:run-1:c1`. The same mail with the memo attached as well answers `No document <the memo's id> that you can read.` and sends nothing: fake-workspace never hears of it. A made-up id gets the same words, so the refusal never says the memo exists.

Sharing the report with Tom invites him as Grace (the invite's `by` is her id). Sharing it with Nina Osei, at Harbour Health, or with Peter Hall, who has left, answers `No person or group <id> in your organisation's directory.`

Run the tests with `pnpm ex test 17.1`. They need Postgres.
