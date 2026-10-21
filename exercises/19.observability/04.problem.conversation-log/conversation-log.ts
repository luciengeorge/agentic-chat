// 👨‍💼 Every chat turn goes to Kestrel's warehouse as one JSON line, and no chat may wait for the warehouse or
//    fail because it's down. So the chat writes an outbox row with its reply, and the line leaves later: the relay
//    hands the row to an exporter, which writes lines in batches and claims each row once its line is written.
//
// 🦉 Already written in this file: the kind and partition, `conversationLine` (a turn as its line), the `Sink`
//    and `fileSink`, `loadTurn` (a row's turn, read back from the messages; exported here so the step's file
//    compiles before `exportConversationLog` uses it), the select that reads a drain's batch (new in this file,
//    inside `exportConversationLog`) and `conversationLogExporter` (the background drains, built on your
//    `exportConversationLog`). The relay's `deliver` (`src/server/plugins/relay-deliver.ts`) calls your
//    `deliverConversationLog` for every log row. You write `enqueueConversationLog`, `exportConversationLog` and
//    `deliverConversationLog`.

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
import { and, asc, eq, isNull } from "drizzle-orm";
import { appendFile } from "node:fs/promises";

import type { OutboxRow } from "#learn/queue/outbox";
import type { Db } from "@/db/create";
import type { Tx } from "@/db/tenant";

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
export async function enqueueConversationLog(
  tx: Tx,
  tenantId: string,
  payload: ConversationLogPayload,
): Promise<string> {
  // 🐨 Insert one outbox row with `tx`: the tenant, `CONVERSATION_LOG_KIND`, the payload as given, and the partition
  //    `conversationPartition(payload.conversationId)`. Return its id.
  // 🐨 The classic mistake: marking it published, or writing the line here. The relay delivers unpublished rows;
  //    a row born published is one the relay never sees, and a line written here puts the sink inside the chat's
  //    transaction.
  //
  // 💰 `tx.insert(outbox).values({...}).returning({ id: outbox.id })`.
  //
  // 🦉 Why the outbox, and not a write to the sink after the reply commits. Two systems can't commit together.
  //    Write the line first and the reply may roll back: a line for a reply nobody got. Commit the reply first
  //    and the process may die before the line: a reply the warehouse never hears of. An outbox row is part of the
  //    reply's own transaction, so both happen or neither does, and the slow, unreliable write to the sink moves
  //    to someone who can retry it. The chat pays one insert.
  //
  // 🚨 The tests check the row, its partition and payload, that it's unpublished, and that a rollback takes it.
  throw new Error(`enqueueConversationLog(${typeof tx}, ${tenantId}, ${payload.replyId}) isn't written yet`);
}

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

export async function loadTurn(tx: Tx, tenantId: string, payload: ConversationLogPayload): Promise<StoredTurn | null> {
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
    // 🦉 New in this file: the select below. It reads this drain's batch, in its transaction: up to `batchSize`
    //    log rows that no one has claimed and that haven't failed, oldest first (by `created_at`, then `id`).
    const rows = await tx
      .select({ id: outbox.id, tenantId: outbox.tenantId, payload: outbox.payload, attempts: outbox.attempts })
      .from(outbox)
      .where(and(eq(outbox.kind, CONVERSATION_LOG_KIND), isNull(outbox.claimedBy), isNull(outbox.failedAt)))
      .orderBy(asc(outbox.createdAt), asc(outbox.id))
      .limit(batchSize);
    // 🐨 Lock the rows it reads: end the select above with a lock. Which lock is the first classic mistake below.
    // 🐨 For each row, `loadTurn`. A turn that's gone (the conversation was deleted) can never be written: mark its
    //    row failed now (`failed_at`, `last_error` "the reply is gone"), count it in `gone`, and skip it. The
    //    others become lines: `JSON.stringify(conversationLine(turn))`.
    // 🐨 No lines: return. Otherwise write them all with one `sink.write`. If it throws, count an attempt on each
    //    of those rows, keep the error as `last_error` (`${error.name}: ${error.message}`), mark a row failed once
    //    its attempts reach `maxAttempts`, and return the error with nothing exported. If it works, claim the rows
    //    (`claimed_by` the exporter's name, `claimed_at` now, one more attempt, `last_error` cleared).
    // 🐨 The classic mistakes. No lock at all: two drains at once both read the row, and its line goes out twice.
    //    `SKIP LOCKED`, as section 05's queue uses it: the relay kicks the exporter while its own transaction still
    //    holds the row it's handing over, so a drain that skips locked rows misses exactly the row it was kicked
    //    for. Wait for the lock instead. And claiming before writing: a crash after the claim and before the write
    //    loses the line forever.
    //
    // 💰 Drizzle ends a select with a row lock through `.for(strength, options?)`: the strengths are `"update"`,
    //    `"no key update"`, `"share"` and `"key share"`, the options `{ skipLocked: true }` or `{ noWait: true }`.
    //    `inArray` and `sql` from `drizzle-orm` (add them to the import); `` sql`${outbox.attempts} + 1` `` adds
    //    one in an update.
    //
    // 🦉 Why claim after the sink, so a line may repeat. One of the two must come first. Claim first and a crash
    //    loses a line nobody can find again; write first and a crash writes it twice. A duplicate carries its
    //    reply id and costs a reader one check. A lost line costs a question nobody can answer. At least once,
    //    deduped by id, is the usual answer.
    // 🦉 Why one sink call per batch. A warehouse or a bucket charges by the request and is slow per call; fifty
    //    lines in one write cost about what one does.
    //
    // 🚨 The tests check the lines and their order, the claim, a failing sink, running out of attempts, a gone
    //    reply, the batch size, a row the relay still holds, two drains at once, and Ella's turn end to end.
    throw new Error(
      `exportConversationLog(${rows.length} rows read, ${typeof sink.write}, ${exporter}, ${maxAttempts} attempts) isn't written yet`,
    );
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
  // 🐨 A payload whose `conversationId` and `replyId` aren't both strings can never be written: throw an
  //    `UndeliverableError` naming the payload, and the relay marks the row failed at once.
  // 🐨 No exporter in this process (the log is off here): the same, with a message that says the conversation
  //    log is off (`CONVERSATION_LOG_FILE` isn't set).
  // 🐨 Otherwise kick the exporter and return. Don't wait for the drain.
  //
  // 💰 `UndeliverableError` from `#learn/queue/outbox`; add the import.
  //
  // 🦉 Why the relay only hands over. The relay drains every kind of outbox row in one pass: syncs, ingests, these.
  //    It calls `start()` for a workflow and moves on; a delivery that waited 1.5 seconds on a slow sink would hold
  //    up every sync behind it. Kicking returns at once, the exporter does the slow part on its own time, and its
  //    claim says the line is written, as a workflow run's first step claims its row.
  //
  // 🚨 The tests check the kick, a bad payload and a process with the log off.
  throw new Error(
    `deliverConversationLog(${row.kind} ${row.id}, ${exporter ? "an exporter" : "no exporter"}) isn't written yet`,
  );
}
