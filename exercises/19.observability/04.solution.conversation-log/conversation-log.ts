/**
 * The conversation log: every finished chat turn, written as one JSON line to a sink (a file here; in production a
 * bucket, a warehouse, a review queue). Product teams read it to see what people ask and how the answers fare.
 *
 * The rule is that a slow or broken sink never slows a chat. So the chat doesn't write to the sink. It writes an
 * outbox row (`#learn/queue/outbox`) in the same transaction as the reply, which costs one insert, and an exporter
 * drains the rows to the sink on its own time. If the sink is down, rows wait; if the process dies, the next drain
 * picks them up. Delivery is at least once: a line can repeat after a crash, and each carries the reply id, so a
 * reader keeps the first.
 *
 * The row goes out like every other outbox row: the relay picks it up (kicked after the chat commits, or on its
 * two-second poll after a crash) and delivers it with `deliverConversationLog`, which hands it to this process's
 * exporter and returns at once, as a workflow start does. The exporter writes the line in its next batch and claims
 * the row then, as a run's first step claims its own. The payload carries ids only; the exporter reads the messages
 * when it writes the line.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { appendFile } from "node:fs/promises";

import type { Db } from "@/db/create";
import type { Tx } from "@/db/tenant";

import { type OutboxRow, UndeliverableError } from "#learn/queue/outbox";
import { conversations, messages, outbox } from "@/db/schema";

export const CONVERSATION_LOG_KIND = "conversation_log";

export const conversationPartition = (conversationId: string) => `conversation:${conversationId}`;

export interface ConversationLogPayload {
  conversationId: string;
  /** The assistant message. Its idempotency key names the user message it answers. */
  replyId: string;
}

/**
 * Adds the log row in the caller's transaction, so it commits with the reply or not at all. It's born unpublished,
 * like any outbox row: the relay delivers it.
 */
export async function enqueueConversationLog(tx: Tx, tenantId: string, payload: ConversationLogPayload) {
  const [row] = await tx
    .insert(outbox)
    .values({
      tenantId,
      kind: CONVERSATION_LOG_KIND,
      payload,
      partitionKey: conversationPartition(payload.conversationId),
    })
    .returning({ id: outbox.id });
  return row.id;
}

const logPayload = (payload: unknown): ConversationLogPayload | null => {
  const { conversationId, replyId } = (payload ?? {}) as { conversationId?: unknown; replyId?: unknown };
  return typeof conversationId === "string" && typeof replyId === "string" ? { conversationId, replyId } : null;
};

interface StoredTurn {
  tenantId: string;
  conversationId: string;
  userId: string;
  question: { id: string; text: string; at: Date } | null;
  reply: { id: string; content: Record<string, unknown>; at: Date };
}

/** One turn as its JSON line: who asked what, what came back, what it rested on and what it cost in tokens. */
export function conversationLine(turn: StoredTurn): Record<string, unknown> {
  const c = turn.reply.content as {
    text?: string;
    status?: string;
    model?: string | null;
    finishReason?: string;
    usage?: unknown;
    sources?: Array<{ label: string; path: string; pageStart: number | null }>;
    verdict?: { citations?: unknown[]; dropped?: unknown[]; abstained?: boolean; flagged?: boolean };
  };
  return {
    type: "chat_turn",
    tenantId: turn.tenantId,
    conversationId: turn.conversationId,
    userId: turn.userId,
    question: turn.question && { id: turn.question.id, text: turn.question.text, at: turn.question.at.toISOString() },
    reply: {
      id: turn.reply.id,
      at: turn.reply.at.toISOString(),
      text: c.text ?? "",
      status: c.status ?? null,
      model: c.model ?? null,
      finishReason: c.finishReason ?? null,
      usage: c.usage ?? null,
      sources: (c.sources ?? []).map((s) => ({ label: s.label, path: s.path, page: s.pageStart })),
      citations: c.verdict?.citations?.length ?? 0,
      dropped: c.verdict?.dropped?.length ?? 0,
      abstained: c.verdict?.abstained ?? false,
      flagged: c.verdict?.flagged ?? false,
    },
  };
}

/** Where lines go. `write` gets a batch, each line one JSON object with no newline. */
export interface Sink {
  write(lines: string[]): Promise<void>;
}

/** Appends lines to a JSON Lines file. */
export function fileSink(path: string): Sink {
  return { write: (lines) => appendFile(path, lines.map((line) => `${line}\n`).join("")) };
}

async function loadTurn(tx: Tx, tenantId: string, payload: ConversationLogPayload): Promise<StoredTurn | null> {
  const [reply] = await tx
    .select({
      id: messages.id,
      content: messages.content,
      at: messages.createdAt,
      key: messages.idempotencyKey,
      userId: conversations.userId,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(messages.id, payload.replyId), eq(messages.conversationId, payload.conversationId)));
  if (!reply) return null;
  const userKey = reply.key?.startsWith("reply:") ? reply.key.slice("reply:".length) : null;
  const [question] = userKey
    ? await tx
        .select({ id: messages.id, content: messages.content, at: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.conversationId, payload.conversationId), eq(messages.idempotencyKey, userKey)))
    : [];
  return {
    tenantId,
    conversationId: payload.conversationId,
    userId: reply.userId,
    question: question ? { id: question.id, text: (question.content as { text: string }).text, at: question.at } : null,
    reply: { id: reply.id, content: reply.content as Record<string, unknown>, at: reply.at },
  };
}

export interface ExportResult {
  exported: number;
  /** Rows whose messages are gone (the conversation was deleted): marked failed, never retried. */
  gone: number;
  /** The sink failed: the batch stays for the next drain. */
  error: string | null;
}

export interface ExportOptions {
  batchSize?: number;
  /** Written to `claimed_by`. */
  exporter?: string;
  /** Sink failures before a row is marked failed and skipped. */
  maxAttempts?: number;
}

/**
 * One drain: in one transaction on the owner's pool (it crosses tenants, like the relay), locks a batch of
 * unclaimed log rows oldest first, writes their lines to the sink in one call, and claims them. A sink failure
 * counts an attempt on each row and leaves them for later.
 *
 * It waits for a row another transaction holds instead of skipping it: the row the relay hands over is still locked
 * by the relay's own transaction when it kicks, and skipped it would wait for the next kick. Two exporters take
 * turns, so lines leave in order.
 */
export async function exportConversationLog(db: Db, sink: Sink, options: ExportOptions = {}): Promise<ExportResult> {
  const { batchSize = 50, exporter = "conversation-log", maxAttempts = 10 } = options;
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: outbox.id, tenantId: outbox.tenantId, payload: outbox.payload, attempts: outbox.attempts })
      .from(outbox)
      .where(and(eq(outbox.kind, CONVERSATION_LOG_KIND), isNull(outbox.claimedBy), isNull(outbox.failedAt)))
      .orderBy(asc(outbox.createdAt), asc(outbox.id))
      .limit(batchSize)
      .for("update");

    const lines: string[] = [];
    const done: string[] = [];
    let gone = 0;
    for (const row of rows) {
      const turn = await loadTurn(tx, row.tenantId, row.payload as ConversationLogPayload);
      if (!turn) {
        gone += 1;
        await tx
          .update(outbox)
          .set({ failedAt: new Date(), lastError: "the reply is gone" })
          .where(eq(outbox.id, row.id));
        continue;
      }
      lines.push(JSON.stringify(conversationLine(turn)));
      done.push(row.id);
    }
    if (lines.length === 0) return { exported: 0, gone, error: null };

    try {
      await sink.write(lines);
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      for (const row of rows.filter((r) => done.includes(r.id))) {
        await tx
          .update(outbox)
          .set({
            attempts: row.attempts + 1,
            lastError: message,
            failedAt: row.attempts + 1 >= maxAttempts ? new Date() : null,
          })
          .where(eq(outbox.id, row.id));
      }
      return { exported: 0, gone, error: message };
    }
    await tx
      .update(outbox)
      .set({ claimedBy: exporter, claimedAt: new Date(), attempts: sql`${outbox.attempts} + 1`, lastError: null })
      .where(inArray(outbox.id, done));
    return { exported: lines.length, gone, error: null };
  });
}

export interface Exporter {
  /** Starts a drain unless one is running, in which case that one goes round again. Never waits, never throws. */
  kick(): void;
  /** Resolves once no drain is running (for tests and scripts). */
  idle(): Promise<void>;
}

/**
 * Drains in the background of this process: `kick()` (from `deliverConversationLog`) starts a drain that repeats
 * until a batch comes back short, so nobody waits for the sink. Failures are reported to `onError` and left for the
 * next kick.
 */
export function conversationLogExporter(
  db: Db,
  sink: Sink,
  { onError = () => {}, ...options }: ExportOptions & { onError?: (error: unknown) => void } = {},
): Exporter {
  const batchSize = options.batchSize ?? 50;
  let running: Promise<void> | null = null;
  let again = false;
  const drain = async () => {
    do {
      again = false;
      try {
        const result = await exportConversationLog(db, sink, { ...options, batchSize });
        if (result.error) onError(new Error(result.error));
        else if (result.exported + result.gone === batchSize) again = true;
      } catch (error) {
        onError(error);
      }
    } while (again);
  };
  return {
    kick() {
      if (running) {
        again = true;
        return;
      }
      running = drain().finally(() => (running = null));
    },
    idle: async () => {
      while (running) await running;
    },
  };
}

/**
 * The relay's delivery of a log row (`src/server/plugins/relay-deliver.ts`): hands it to this process's exporter
 * and returns at once, so the relay's pass never waits on the sink. The exporter claims the row once its line is
 * written. A payload that isn't one, or a process with the log off, can never deliver it: undeliverable, so the
 * relay marks it failed at once.
 */
export function deliverConversationLog(row: OutboxRow, exporter: Exporter | null): void {
  if (!logPayload(row.payload)) {
    throw new UndeliverableError(`bad conversation_log payload ${JSON.stringify(row.payload)}`);
  }
  if (!exporter) {
    throw new UndeliverableError("the conversation log is off in this process (CONVERSATION_LOG_FILE isn't set)");
  }
  exporter.kick();
}
