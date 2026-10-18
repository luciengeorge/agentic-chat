// 👨‍💼 `POST /api/chat` takes whatever bytes arrive. Most come from Kestrel's chat page; some will come from curl, a
//    script, or someone curious about what happens if they change a field. This file decides what a request may
//    say before anything acts on it.

/**
 * What `POST /api/chat` accepts (section 11.3). The body is the client's to choose, so it's checked before anything
 * runs on it, and it names only what the user may choose: which conversation, and the new message. Who is asking,
 * and for which tenant, comes from the session.
 */
import { z } from "zod";

import type { Viewer } from "#learn/retrieve/types";

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_QUESTION_CHARS = 4000;

/** What the browser sends: the conversation id and only the newest message (the server keeps the history). The
 * message id is the idempotency key. Nothing here names a tenant or a user: those come from the session. */
// 🐨 Describe the body `useChat` sends, and nothing more: `id`, the conversation's uuid, and `message`, an object
//    with its `id` (1 to 64 letters, digits, `_` or `-`), `role` (only "user") and `parts` (1 to 8 objects, each
//    `{ type: "text", text: string }`).
//
// 💰 `z.uuid()`, `z.string().regex(/^...$/)`, `z.literal("user")`, `z.array(...).min(1).max(8)`.
//
// 🦉 Why only "user". The server keeps the conversation, so the client never sends an answer. A body that could
//    say `role: "assistant"` could plant words in the assistant's mouth, and the next turn's history would quote
//    them as the assistant's own.
// 🦉 Why a pattern on the message id. It's the idempotency key (a retry with the same id replays the stored reply)
//    and it goes into a unique index. 64 safe characters can't be a megabyte, or a string that breaks a log line.
export const ChatRequestSchema = z.object({});

/** One checked request: who asks (from the session), in which conversation, with which message key, and what. */
export interface ChatTurn {
  scope: Viewer;
  conversationId: string;
  messageKey: string;
  question: string;
}

/**
 * Reads and checks a chat request's body: the turn, or the 413 or 400 to answer instead. `scope` is the viewer the
 * middleware loaded; the turn is always theirs.
 */
export async function readChatTurn(request: Request, scope: Viewer): Promise<ChatTurn | Response> {
  // 🐨 Refuse a body that's too big before reading it: a `content-length` header over `MAX_BODY_BYTES` is a 413
  //    `too_large`. Then read the body, and refuse it again if it's more than `MAX_BODY_BYTES` bytes (the header
  //    can be missing, or lie). Bytes, not characters: count them before you turn the body into a string.
  // 🐨 Parse it as JSON (not JSON: 400 `invalid_json`), then with `ChatRequestSchema.safeParse` (a failure: 400
  //    `invalid_request`, with `issues` from `z.flattenError(error).fieldErrors`).
  // 🐨 The question is the text parts joined with a newline, trimmed. Empty: 400 `empty_question`. Longer than
  //    `MAX_QUESTION_CHARS`: 400 `question_too_long`, with `max`.
  // 🐨 Return the turn: `scope` as you were given it, the conversation id, the message id as `messageKey`, and
  //    the question.
  // 🐨 The classic mistake: reading the tenant (or the user) from the body. The body is the client's to write.
  //
  // 💰 `request.headers.get("content-length")` is a string or null; `Number(null)` is 0.
  //    `await request.arrayBuffer()` gives the bytes, and `.byteLength` counts them; `new TextDecoder().decode(bytes)`
  //    turns UTF-8 bytes into a string.
  //    `Response.json({ error: "invalid_json" }, { status: 400 })` is an answer.
  //
  // 🦉 Why the tenant never comes from here. Leo can send any bytes he likes: curl doesn't care what the page
  //    would have sent. Put `tenantId` in the schema and use it, and he can add Harbour's id and read Harbour's
  //    documents with a Kestrel login. The session says who he is; the membership says where. `z.object` also
  //    drops keys it doesn't name, so a `tenantId` he slips in never reaches you.
  // 🦉 Why check the size twice. Reading a body costs memory, so a header saying 10 MB is refused unread. But the
  //    header is optional and is just another thing the client wrote, so the body is measured again once read.
  // 🦉 Why bytes. A string's `length` counts UTF-16 code units, roughly characters. "£" is one of those and two
  //    bytes of UTF-8, "€" three, and an emoji is two code units and four bytes. So 33,000 "£" signs are 66,000 bytes, over the limit,
  //    and a `.length` check says 33,000 and lets them through.
  // 🦉 Why this order. Each check is cheaper than the next, and none of them costs a token of the rate limit, a
  //    retrieval or a model call: the route does those only once a turn comes back.
  //
  // 📜 https://zod.dev/api (objects, strings, arrays, safeParse)
  // 📜 https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/
  //
  // 🚨 The tests check the body useChat sends is read as a turn for the session's viewer, each refusal and its
  //    status, the size checked before and after reading, and that a body naming Harbour's tenant still stores
  //    Leo's conversation in Kestrel.
  throw new Error(`readChatTurn(${request.method} ${request.url}, ${scope.userId}) isn't written yet`);
}
