import { and, desc, eq, lt, sql } from "drizzle-orm";

import type { Usage } from "#learn/model/types";
import type { TextMessage } from "#learn/model/types";
import type { Viewer } from "#learn/retrieve/types";
import type { ConversationSummary, ReplyStatus, SourceRef, StoredUIMessage, Verdict } from "@/components/chat/types";
import type { Tx } from "@/db/tenant";

import { readable } from "#learn/retrieve/acl";
import { uuidArray } from "#learn/search/sql";
import { conversations, messages } from "@/db/schema";

/** What `messages.content` holds. A user turn keeps its text; a reply keeps what the UI needs to redraw it. */
export interface UserContent {
  text: string;
}

export interface ReplyContent {
  text: string;
  status: ReplyStatus;
  sources: SourceRef[];
  verdict: Verdict;
  auditId: string | null;
  model: string | null;
  finishReason: string;
  usage: Usage | null;
}

export interface StoredReply {
  id: string;
  content: ReplyContent;
}

/** History sent back to the model, newest last. Older turns fall to the prompt's token budget anyway. */
const HISTORY_TURNS = 12;
const TITLE_CHARS = 80;

const replyKey = (userKey: string) => `reply:${userKey}`;

function titleOf(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

/** Locks the conversation for this transaction, so its messages get their seq one at a time. Null when it
 * isn't the viewer's (another user's, or another tenant's, which RLS hides). */
async function lockConversation(tx: Tx, viewer: Viewer, conversationId: string) {
  const [row] = await tx
    .select({ userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for("update");
  return row && row.userId === viewer.userId ? row : null;
}

async function nextSeq(tx: Tx, conversationId: string): Promise<number> {
  const [{ seq }] = await tx
    .select({ seq: sql<number>`coalesce(max(${messages.seq}), 0) + 1` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  return Number(seq);
}

export type Turn =
  | { kind: "not-found" }
  | { kind: "replay"; reply: StoredReply }
  | { kind: "new"; history: TextMessage[] };

/**
 * Starts a turn: makes the conversation on its first message, and adds the user's message once per idempotency
 * key. A retry whose reply is already stored gets that reply back to replay; one whose reply never finished
 * gets a new answer.
 */
export async function beginTurn(
  tx: Tx,
  viewer: Viewer,
  conversationId: string,
  message: { key: string; text: string },
): Promise<Turn> {
  await tx
    .insert(conversations)
    .values({ id: conversationId, tenantId: viewer.tenantId, userId: viewer.userId, title: titleOf(message.text) })
    .onConflictDoNothing();
  if (!(await lockConversation(tx, viewer, conversationId))) return { kind: "not-found" };

  const [existing] = await tx
    .select({ seq: messages.seq })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.idempotencyKey, message.key)));

  let seq: number;
  if (existing) {
    const [reply] = await tx
      .select({ id: messages.id, content: messages.content })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.idempotencyKey, replyKey(message.key))));
    const content = reply?.content as ReplyContent | undefined;
    if (reply && content?.status === "complete") return { kind: "replay", reply: { id: reply.id, content } };
    seq = existing.seq;
  } else {
    seq = await nextSeq(tx, conversationId);
    await tx.insert(messages).values({
      tenantId: viewer.tenantId,
      conversationId,
      seq,
      role: "user",
      content: { text: message.text } satisfies UserContent,
      idempotencyKey: message.key,
    });
    await tx.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));
  }

  const rows = await tx
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), lt(messages.seq, seq)))
    .orderBy(desc(messages.seq))
    .limit(HISTORY_TURNS);
  const history = rows
    .reverse()
    .filter((row) => row.role === "user" || (row.content as ReplyContent).status === "complete")
    .map((row) => ({ role: row.role as "user" | "assistant", content: (row.content as UserContent).text }));
  return { kind: "new", history };
}

/** Stores a reply once: a second reply to the same user message (a concurrent retry) is dropped, unless the
 * stored one was stopped, which the new one replaces. */
export async function saveReply(
  tx: Tx,
  viewer: Viewer,
  conversationId: string,
  reply: { id: string; userKey: string; content: ReplyContent },
): Promise<boolean> {
  if (!(await lockConversation(tx, viewer, conversationId))) return false;
  const inserted = await tx
    .insert(messages)
    .values({
      id: reply.id,
      tenantId: viewer.tenantId,
      conversationId,
      seq: await nextSeq(tx, conversationId),
      role: "assistant",
      content: reply.content,
      idempotencyKey: replyKey(reply.userKey),
    })
    .onConflictDoUpdate({
      target: [messages.conversationId, messages.idempotencyKey],
      set: { id: reply.id, content: reply.content },
      setWhere: sql`${messages.content}->>'status' = 'aborted'`,
    })
    .returning({ id: messages.id });
  await tx.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));
  return inserted.length > 0;
}

export async function listConversations(tx: Tx, viewer: Viewer, limit = 50): Promise<ConversationSummary[]> {
  const rows = await tx
    .select({ id: conversations.id, title: conversations.title, updatedAt: conversations.updatedAt })
    .from(conversations)
    .where(eq(conversations.userId, viewer.userId))
    .orderBy(desc(conversations.updatedAt))
    .limit(limit);
  return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
}

export function replyToUIMessage(reply: StoredReply): StoredUIMessage {
  const { content } = reply;
  return {
    id: reply.id,
    role: "assistant",
    metadata: { status: content.status },
    parts: [
      { type: "data-sources", id: "sources", data: { sources: content.sources } },
      { type: "text", text: content.text, state: "done" },
      { type: "data-verdict", id: "verdict", data: content.verdict },
    ],
  };
}

/** Of these documents, the ones the viewer may read now, in one query. */
async function readableDocuments(tx: Tx, userId: string, documentIds: string[]): Promise<Set<string>> {
  if (documentIds.length === 0) return new Set();
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT d.id FROM unnest(${uuidArray(documentIds)}) AS d(id) WHERE ${readable(userId, sql`d.id`)}`);
  return new Set(rows.map((row) => row.id));
}

/** A reply without the sources and citations of documents the viewer can no longer read. */
function readableReply(content: ReplyContent, allowed: Set<string>): ReplyContent {
  return {
    ...content,
    sources: content.sources.filter((source) => allowed.has(source.documentId)),
    verdict: {
      ...content.verdict,
      citations: content.verdict.citations.filter((citation) => allowed.has(citation.documentId)),
    },
  };
}

/** A conversation's messages in the shape `useChat` takes, or null when it isn't the viewer's. A stored reply
 * shows only the sources the viewer may still read: a document unshared since keeps its title and path to itself. */
export async function loadConversation(
  tx: Tx,
  viewer: Viewer,
  conversationId: string,
): Promise<{ title: string | null; messages: StoredUIMessage[] } | null> {
  const [conversation] = await tx
    .select({ userId: conversations.userId, title: conversations.title })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (!conversation || conversation.userId !== viewer.userId) return null;

  const rows = await tx
    .select({ id: messages.id, role: messages.role, content: messages.content, key: messages.idempotencyKey })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.seq);
  const replies = rows.filter((row) => row.role === "assistant").map((row) => row.content as ReplyContent);
  // Citations point at sources, so the sources name every document.
  const allowed = await readableDocuments(tx, viewer.userId, [
    ...new Set(replies.flatMap((reply) => reply.sources.map((source) => source.documentId))),
  ]);
  return {
    title: conversation.title,
    messages: rows.map((row): StoredUIMessage => {
      if (row.role === "assistant") {
        return replyToUIMessage({ id: row.id, content: readableReply(row.content as ReplyContent, allowed) });
      }
      return {
        id: row.key ?? row.id,
        role: "user",
        parts: [{ type: "text", text: (row.content as UserContent).text }],
      };
    }),
  };
}
