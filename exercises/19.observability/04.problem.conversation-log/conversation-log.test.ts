// @vitest-environment node
import { sql } from "drizzle-orm";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Retrieve } from "#learn/retrieve/types";

import { APP_K, recordedTurn, replayModel } from "#learn/generate/recorded";
import {
  CONVERSATION_LOG_KIND,
  conversationLogExporter,
  deliverConversationLog,
  enqueueConversationLog,
  type Exporter,
  exportConversationLog,
  fileSink,
  type Sink,
} from "#learn/observability/conversation-log";
import { type OutboxRow, relayOnce, UndeliverableError } from "#learn/queue/outbox";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { chatObserver } from "@/lib/observability.server";
import { handleChat } from "@/routes/api/chat/-chat";
import { deliver } from "@/server/plugins/relay-deliver";

const ELLA = "55555555-5555-4555-8555-555555555555";

/** A sink that keeps each write's lines, and can be told to fail or to take its time. */
function memorySink(options: { fail?: string; delayMs?: number } = {}) {
  const writes: string[][] = [];
  const sink: Sink = {
    write: async (lines) => {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.fail) throw new Error(options.fail);
      writes.push(lines);
    },
  };
  return { sink, writes, lines: () => writes.flat().map((line) => JSON.parse(line)) };
}

describe.skipIf(!postgresAvailable)("the conversation log", () => {
  let t: TestDatabase;
  let tenant: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: tenant }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
    await t.sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, enabled, synced_at)
                VALUES (${ELLA}, ${tenant}, 'user', ${ELLA}, 'ella.brooks', 'ella.brooks', true, now())`;
  });

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    await t.sql`DELETE FROM outbox`;
    await t.sql`DELETE FROM conversations`;
  });

  /** A finished turn, stored as the chat stores one: the question, and a reply keyed `reply:<the question's key>`. */
  async function storedTurn(question: string) {
    const [{ id: conversationId }] = await t.sql`
      INSERT INTO conversations (tenant_id, user_id, title) VALUES (${tenant}, ${ELLA}, ${question}) RETURNING id`;
    const key = crypto.randomUUID();
    await t.sql`INSERT INTO messages (tenant_id, conversation_id, seq, role, content, idempotency_key)
                VALUES (${tenant}, ${conversationId}, 1, 'user', ${JSON.stringify({ text: question })}::jsonb, ${key})`;
    const reply = {
      text: `About ${question}`,
      status: "complete",
      sources: [],
      verdict: { citations: [], dropped: [] },
    };
    const [{ id: replyId }] = await t.sql`
      INSERT INTO messages (tenant_id, conversation_id, seq, role, content, idempotency_key)
      VALUES (${tenant}, ${conversationId}, 2, 'assistant', ${JSON.stringify(reply)}::jsonb, ${`reply:${key}`})
      RETURNING id`;
    return { conversationId: conversationId as string, replyId: replyId as string };
  }

  /** The log row for a turn, as the chat writes it, `ageSeconds` old. */
  async function logRow(turn: { conversationId: string; replyId: string }, ageSeconds = 0) {
    const [{ id }] = await t.sql`
      INSERT INTO outbox (tenant_id, kind, payload, partition_key, created_at)
      VALUES (${tenant}, ${CONVERSATION_LOG_KIND}, ${JSON.stringify(turn)}::jsonb, ${`conversation:${turn.conversationId}`},
              now() - make_interval(secs => ${ageSeconds}))
      RETURNING id`;
    return id as string;
  }

  const row = async (id: string) => {
    const [r] = await t.sql`
      SELECT kind, partition_key, payload, attempts, last_error, published_at, failed_at, claimed_by, claimed_at
      FROM outbox WHERE id = ${id}`;
    return r;
  };

  describe("enqueueConversationLog", () => {
    it("writes an unpublished conversation_log row, partitioned by conversation, with ids only", async () => {
      const turn = await storedTurn("Meals?");
      const id = await withTenantOn(t.appDb, tenant, (tx) => enqueueConversationLog(tx, tenant, turn));
      expect(typeof id, "return the new row's id").toBe("string");
      const r = await row(id);
      expect(r, "kind conversation_log, partition conversation:<its id>, the payload as given").toMatchObject({
        kind: "conversation_log",
        partition_key: `conversation:${turn.conversationId}`,
        payload: turn,
        attempts: 0,
        claimed_by: null,
      });
      expect(r.published_at, "born unpublished: the relay delivers it, like every outbox row").toBeNull();
    });

    it("writes it in the caller's transaction, so a rolled-back reply leaves no row", async () => {
      const turn = await storedTurn("Meals?");
      await expect(
        withTenantOn(t.appDb, tenant, async (tx) => {
          await enqueueConversationLog(tx, tenant, turn);
          throw new Error("the reply failed to save");
        }),
      ).rejects.toThrow("failed to save");
      const [{ count }] = await t.sql`SELECT count(*)::int AS count FROM outbox`;
      expect(count, "insert with the tx you were given, so it rolls back with the reply").toBe(0);
    });
  });

  describe("deliverConversationLog", () => {
    const logRowOf = (payload: unknown): OutboxRow => ({
      id: "r1",
      tenantId: "t1",
      kind: CONVERSATION_LOG_KIND,
      payload,
      partitionKey: "conversation:c1",
      attempts: 0,
    });

    it("hands the row to the exporter with a kick, and returns at once", () => {
      const kicks: string[] = [];
      const exporter: Exporter = { kick: () => void kicks.push("kick"), idle: async () => {} };
      expect(deliverConversationLog(logRowOf({ conversationId: "c1", replyId: "m2" }), exporter)).toBeUndefined();
      expect(kicks).toEqual(["kick"]);
    });

    it("makes a row it can never deliver undeliverable: a bad payload, or a process with the log off", () => {
      const exporter: Exporter = { kick: () => {}, idle: async () => {} };
      expect(() => deliverConversationLog(logRowOf({ conversationId: "c1" }), exporter)).toThrow(UndeliverableError);
      expect(() => deliverConversationLog(logRowOf(null), exporter)).toThrow(UndeliverableError);
      expect(() => deliverConversationLog(logRowOf({ conversationId: "c1", replyId: "m2" }), null)).toThrow(
        /conversation log is off/,
      );
      expect(() => deliverConversationLog(logRowOf({ conversationId: "c1", replyId: "m2" }), null)).toThrow(
        UndeliverableError,
      );
    });
  });

  describe("exportConversationLog", () => {
    it("writes every unclaimed row's line in one sink call, oldest first, then claims them", async () => {
      const first = await logRow(await storedTurn("Meals?"), 20);
      const second = await logRow(await storedTurn("Hotels?"), 10);
      const { sink, writes, lines } = memorySink();
      expect(await exportConversationLog(t.db, sink)).toEqual({ exported: 2, gone: 0, error: null });
      expect(writes, "one write for the batch").toHaveLength(1);
      expect(
        lines().map((l) => l.question.text),
        "oldest first",
      ).toEqual(["Meals?", "Hotels?"]);
      expect(lines()[0]).toMatchObject({ type: "chat_turn", userId: ELLA, reply: { text: "About Meals?" } });
      for (const id of [first, second]) {
        const r = await row(id);
        expect(r, "claimed once the line is written").toMatchObject({
          claimed_by: "conversation-log",
          attempts: 1,
          last_error: null,
        });
        expect(r.claimed_at).not.toBeNull();
      }
      expect(await exportConversationLog(t.db, sink), "claimed rows are never written again").toEqual({
        exported: 0,
        gone: 0,
        error: null,
      });
    });

    it("claims nothing when the sink fails, counts an attempt on each row, and writes them on the next drain", async () => {
      const ids = [await logRow(await storedTurn("Meals?"), 20), await logRow(await storedTurn("Hotels?"), 10)];
      expect(await exportConversationLog(t.db, memorySink({ fail: "bucket unreachable" }).sink)).toEqual({
        exported: 0,
        gone: 0,
        error: "Error: bucket unreachable",
      });
      for (const id of ids) {
        expect(
          await row(id),
          "not claimed (the line isn't written), one attempt counted, the error kept",
        ).toMatchObject({
          claimed_by: null,
          attempts: 1,
          last_error: "Error: bucket unreachable",
          failed_at: null,
        });
      }
      const ok = memorySink();
      expect(await exportConversationLog(t.db, ok.sink)).toMatchObject({ exported: 2, error: null });
      expect(ok.lines().map((l) => l.question.text)).toEqual(["Meals?", "Hotels?"]);
    });

    it("fails a row once its attempts run out, and leaves it alone after", async () => {
      const id = await logRow(await storedTurn("Meals?"));
      await exportConversationLog(t.db, memorySink({ fail: "down" }).sink, { maxAttempts: 2 });
      expect((await row(id)).failed_at).toBeNull();
      await exportConversationLog(t.db, memorySink({ fail: "down" }).sink, { maxAttempts: 2 });
      expect((await row(id)).failed_at, "2 attempts of 2: failed").not.toBeNull();
      const ok = memorySink();
      expect(await exportConversationLog(t.db, ok.sink), "a failed row is skipped").toMatchObject({ exported: 0 });
    });

    it("fails the row of a reply that's gone, and still writes the others", async () => {
      const turn = await storedTurn("Meals?");
      const gone = await logRow({ conversationId: turn.conversationId, replyId: crypto.randomUUID() }, 20);
      await logRow(turn, 10);
      const { sink, lines } = memorySink();
      expect(await exportConversationLog(t.db, sink)).toEqual({ exported: 1, gone: 1, error: null });
      expect(lines().map((l) => l.question.text)).toEqual(["Meals?"]);
      expect(await row(gone), "a reply that's gone can never be written: fail its row").toMatchObject({
        last_error: "the reply is gone",
        claimed_by: null,
      });
      expect((await row(gone)).failed_at).not.toBeNull();
    });

    it("takes at most batchSize rows a drain", async () => {
      for (const [i, q] of ["one?", "two?", "three?"].entries()) await logRow(await storedTurn(q), 30 - i);
      const { sink, lines } = memorySink();
      expect(await exportConversationLog(t.db, sink, { batchSize: 2 })).toMatchObject({ exported: 2 });
      expect(lines().map((l) => l.question.text)).toEqual(["one?", "two?"]);
    });

    it("waits for a row another transaction holds, as the relay does while it hands one over", async () => {
      const id = await logRow(await storedTurn("Meals?"));
      const { sink, lines } = memorySink();
      let drain: ReturnType<typeof exportConversationLog> | undefined;
      await t.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM outbox WHERE id = ${id} FOR UPDATE`);
        drain = exportConversationLog(t.db, sink);
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
      expect(
        await drain!,
        "the row was locked when the drain began: wait for the lock (FOR UPDATE), don't SKIP LOCKED past it",
      ).toMatchObject({ exported: 1 });
      expect(lines()).toHaveLength(1);
    });
  });

  describe("Ella Brooks's Brightwell turn, end to end", () => {
    it("answers while a 1.5 s sink waits, and the line arrives after one relay pass", async () => {
      const file = join(mkdtempSync(join(tmpdir(), "conversation-log-")), "conversations.jsonl");
      const slow = (inner: Sink): Sink => ({
        write: async (lines) => {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          await inner.write(lines);
        },
      });
      const exporter = conversationLogExporter(t.db, slow(fileSink(file)));
      const turn = recordedTurn("brightwell");
      const retrieve: Retrieve = async (_viewer, query) => ({
        query,
        rewritten: turn.rewritten,
        chunks: turn.chunks.slice(0, APP_K),
        auditId: "a",
      });
      const lines = () =>
        readFileSync(file, { encoding: "utf8", flag: "a+" })
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));

      const started = performance.now();
      const response = await handleChat(
        new Request("http://localhost:3000/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: crypto.randomUUID(),
            message: { id: "m1", role: "user", parts: [{ type: "text", text: turn.question }] },
          }),
        }),
        { tenantId: tenant, userId: ELLA },
        {
          db: t.appDb,
          retrieve,
          model: replayModel("brightwell").model,
          reasoningEffort: "medium",
          bucket: { name: "chat", capacity: 100, refillPerSecond: 0.001 },
          observe: chatObserver({}, null, exporter),
        },
      );
      await response.text();
      expect(response.status).toBe(200);
      expect(performance.now() - started, "the chat never waits for the sink").toBeLessThan(1_000);
      expect(lines(), "nothing is written until the relay hands the row over").toEqual([]);

      const pass = await relayOnce(t.db, (r) => deliver(r, () => exporter));
      expect(pass.published, "one relay pass delivers the log row").toHaveLength(1);
      await exporter.idle();

      const [line] = lines();
      expect(line).toMatchObject({
        type: "chat_turn",
        userId: ELLA,
        question: { text: turn.question },
        reply: {
          status: "complete",
          model: "openai.responses:gpt-6-luna",
          usage: { inputTokens: 1_776, outputTokens: 79 },
          citations: 2,
          dropped: 0,
          abstained: false,
        },
      });
      expect(line.reply.text).toContain("16 November 2026");
      expect(line.reply.sources.map((s: { label: string }) => s.label)).toEqual([
        "S1",
        "S2",
        "S3",
        "S4",
        "S5",
        "S6",
        "S7",
        "S8",
      ]);
      const r = await row(pass.published[0]);
      expect(r, "published by the relay, claimed by the exporter: one attempt each").toMatchObject({
        claimed_by: "conversation-log",
        attempts: 2,
      });
      expect(r.published_at).not.toBeNull();
    });
  });
});
