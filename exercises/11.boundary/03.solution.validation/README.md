---
title: Validating the request, and where the tenant comes from
type: graded
slots:
  boundary/chat-request: chat-request.ts
---

# Validating the request: the solution

`ChatRequestSchema` is `z.object({ id: z.uuid(), message: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), role: z.literal("user"), parts: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1).max(8) }) })`.

`readChatTurn` refuses a `content-length` over `MAX_BODY_BYTES` with 413 before reading, reads the body's bytes (`request.arrayBuffer()`) and refuses it again if there are more than that, decodes them with `TextDecoder`, parses JSON (400 `invalid_json`), `safeParse`s (400 `invalid_request` with the flattened field errors), joins the text parts with `\n` and trims, refuses empty (400 `empty_question`) or over 4,000 characters (400 `question_too_long`), and returns `{ scope, conversationId, messageKey, question }` with the `scope` it was given.

## Why it works

- **The schema describes only the user's choices.** Which conversation, and the new message. Who's asking and in which tenant are facts about the session, loaded by the middleware; they have no field to be written into.
- **Unknown keys disappear.** `z.object` strips keys it doesn't name, so a `tenantId` in the body never reaches the handler, and `handleChat` runs everything (the rate limit, the conversation row, retrieval) for `chat.scope`.
- **Every limit is a cost refused early.** The header check refuses a big body unread; the second check catches a header that lied; the question limit caps what retrieval and the model are asked. None of these spends a rate-limit token.
- **Role is always user.** The server owns the history, so a client can't plant an assistant turn that later shows up as the assistant's own words.

## The worked example

Leo's 177-byte body becomes `{ scope: Leo in Kestrel, conversationId, messageKey: "Xq3vL9tRk2PwN8sD", question }`. The same body plus `"tenantId": "<Harbour>"` is answered the same way and stored in Kestrel; Harbour has 0 conversations.

One check to notice: the second size check counts bytes. A string's `length` counts characters (UTF-16 code units, to be exact), and `£` is one character but two bytes of UTF-8. A question of 33,000 `£` signs is about 33,170 characters of JSON and 66,170 bytes, so a `raw.length` check would let it through whenever the header lied or was missing. Counting `byteLength` before decoding measures what actually arrived.
