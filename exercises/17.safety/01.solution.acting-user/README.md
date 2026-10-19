---
title: Authorisation as the acting user
type: graded
slots:
  agent/tools/send-mail: send-mail.ts
  agent/tools/share-document: share-document.ts
---

# Authorisation as the acting user: the solution

`send_mail` opens one tenant transaction and runs `readableDocument(tx, userId, id)` for each distinct attachment; the first null throws `notReadable(id)`. Only then does it call the writer's `sendMail(userId, { to, subject, body, attachments }, ctx.idempotencyKey, ctx.signal)`, with each attachment as its `externalId` and title.

`share_document` checks the document the same way, then looks the recipient up with `WHERE id = $recipient AND tenant_id = $viewer's tenant AND enabled`, throwing "No person or group ..." when there's no row. Then `invite(userId, document.externalId, recipientId, ctx.idempotencyKey, ctx.signal)`.

## Why it works

- **Every id is checked as the user.** The model's ids come from anywhere. `canRead` in Postgres decides for each one, so a write can only carry what the user could open themselves.
- **All checks before any send.** A three-attachment mail whose third is refused sends nothing.
- **Missing and forbidden read the same.** "No document X that you can read" for both, so a refusal can't be used to learn what exists.
- **The tenant is named.** RLS already scopes `principals` to Kestrel, and the query says `tenant_id` too, so the check holds in code that runs without RLS.
- **The drive checks again.** The invite carries Grace as its acting user, and fake-workspace refuses a user who can't read the item. Mail has the same second line: fake-workspace refuses an attachment its sender can't read.
- **One call, one key.** `ctx.idempotencyKey` stays the same when a call is retried, so fake-workspace replays the first answer instead of sending again.

## The worked example

Grace reads 18 of 40; Daniel Reyes 25, the memo included; Tom 19, without it. Grace's mail with the report and the memo: refused at the memo, nothing sent. Her share of the report with Tom: one invite, `by` Grace, key `agent:run-1:c1`. Nina at Harbour and Peter Hall (disabled) don't exist as far as Grace's tenant is concerned.
