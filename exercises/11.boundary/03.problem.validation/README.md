---
title: Validating the request, and where the tenant comes from
type: graded
slots:
  boundary/chat-request: chat-request.ts
---

# Validating the request, and where the tenant comes from

👨‍💼 Leo's chat page sends `POST /api/chat` with his question. So can anything else that has his cookie: curl, a script, Leo himself with the browser's dev tools open, changing a field to see what happens. Everything in a request body is the client's to write, so nothing in it is trusted until it has been checked, and some things are never taken from it at all.

## Terms

- **zod** is the library the app writes schemas in. A **schema** describes the shape a value must have; `safeParse` checks a value against it and says what's wrong.
- **Validation** is that check, done on every input before anything acts on it.
- **413** (Payload Too Large) and **400** (Bad Request) are the HTTP answers for a body that's too big and one that's malformed.
- An **idempotency key** is an id the client sends so a retry isn't done twice. The message id is the chat's.
- **Broken object-level authorization** is the classic API bug: the server takes "which tenant" or "which user" from the request and acts on it.

## Do this

🐨 In `playground/chat-request.ts`, write `ChatRequestSchema` (the conversation id and the new message, nothing else) and `readChatTurn` (the size checks, the parse, the question, then the turn for the viewer you're given). `handleChat` calls it first and acts for the turn's `scope` from then on.

## A worked example

For "What is the hotel limit for a night in London?", `useChat` sends 177 bytes: `{"id":"<conversation uuid>","message":{"id":"Xq3vL9tRk2PwN8sD","role":"user","parts":[{"type":"text","text":"What is the hotel limit for a night in London?"}]}}`. The limit is 65,536 bytes of body and 4,000 characters of question: 4,000 passes, 4,001 is a 400.

Now Leo adds `"tenantId": "<Harbour's id>"` to the body. The schema doesn't name it, so `safeParse` drops it, the turn's scope is still Leo in Kestrel, and the conversation row is written with Kestrel's tenant id. Harbour has 0 conversations after the request. (Refusing the extra key with `.strict()` is fine too; using it never is.)

Run the tests with `pnpm ex test 11.3`. The last one needs Postgres (`pnpm ex up`).
