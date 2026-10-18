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
export const ChatRequestSchema = z.object({
  id: z.uuid(),
  message: z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    role: z.literal("user"),
    parts: z
      .array(z.object({ type: z.literal("text"), text: z.string() }))
      .min(1)
      .max(8),
  }),
});

/** One checked request: who asks (from the session), in which conversation, with which message key, and what. */
export interface ChatTurn {
  scope: Viewer;
  conversationId: string;
  messageKey: string;
  question: string;
}

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status });

/**
 * Reads and checks a chat request's body: the turn, or the 413 or 400 to answer instead. `scope` is the viewer the
 * middleware loaded; the turn is always theirs.
 */
export async function readChatTurn(request: Request, scope: Viewer): Promise<ChatTurn | Response> {
  // Content-length can be missing or wrong, so the body is measured again once read.
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return json(413, { error: "too_large" });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "too_large" });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) return json(400, { error: "invalid_request", issues: z.flattenError(parsed.error).fieldErrors });

  const question = parsed.data.message.parts
    .map((p) => p.text)
    .join("\n")
    .trim();
  if (!question) return json(400, { error: "empty_question" });
  if (question.length > MAX_QUESTION_CHARS) return json(400, { error: "question_too_long", max: MAX_QUESTION_CHARS });

  return { scope, conversationId: parsed.data.id, messageKey: parsed.data.message.id, question };
}
