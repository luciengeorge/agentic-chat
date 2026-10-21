// @vitest-environment node
import type { HistogramMetricData, SumMetricData } from "@opentelemetry/sdk-metrics";

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Retrieve, RetrievedChunk } from "#learn/retrieve/types";

import { scriptedModel } from "#learn/model/testing";
import {
  CONVERSATION_LOG_KIND,
  conversationLogExporter,
  exportConversationLog,
  fileSink,
  type Sink,
} from "#learn/observability/conversation-log";
import { type Exporter } from "#learn/observability/conversation-log";
import { testTelemetry } from "#learn/observability/testing";
import { relayOnce } from "#learn/queue/outbox";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { chatObserver, conversationLogPass } from "@/lib/observability.server";
import { relayPass } from "@/routes/api/cron/-cron";
import { deliver } from "@/server/plugins/relay-deliver";

import { handleChat, type ChatDeps } from "./-chat";

const LEO = "44444444-4444-4444-8444-444444444444";

const POLICY_V2: RetrievedChunk = {
  id: "11111111-aaaa-4aaa-8aaa-111111111111",
  documentId: "22222222-bbbb-4bbb-8bbb-222222222222",
  title: "Expenses policy v2",
  path: "/Kestrel/Policies/expenses-v2.pdf",
  text: "Meals while travelling are reimbursed up to £45 per day.",
  pageStart: 3,
  pageEnd: 3,
  section: "Meals",
  score: 0.9,
};

const CITED = 'Up to £45 a day [[S1: "reimbursed up to £45 per day"]].';

const slowSink = (inner: Sink, ms: number): Sink => ({
  write: async (lines) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await inner.write(lines);
  },
});

describe.skipIf(!postgresAvailable)("observing POST /api/chat", () => {
  let t: TestDatabase;
  let tenant: string;
  let file: string;
  let n = 0;

  const retrieve: Retrieve = async (_viewer, query) => ({ query, rewritten: [], chunks: [POLICY_V2], auditId: "a" });

  const deps = (observe: ChatDeps["observe"], capacity = 100): ChatDeps => ({
    db: t.appDb,
    retrieve,
    model: scriptedModel(CITED).model,
    reasoningEffort: "medium",
    bucket: { name: "chat", capacity, refillPerSecond: 0.001 },
    observe,
  });

  const ask = (d: ChatDeps, text: string) =>
    handleChat(
      new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          message: { id: `m${++n}`, role: "user", parts: [{ type: "text", text }] },
        }),
      }),
      { tenantId: tenant, userId: LEO },
      d,
    );

  const lines = () =>
    readFileSync(file, { encoding: "utf8", flag: "a+" })
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: tenant }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
    await t.sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, enabled, synced_at)
                VALUES (${LEO}, ${tenant}, 'user', ${LEO}, 'leo.martin', 'leo.martin', true, now())`;
  });

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    file = join(mkdtempSync(join(tmpdir(), "conversation-log-")), "conversations.jsonl");
    await t.sql`DELETE FROM outbox`;
    await t.sql`DELETE FROM rate_limit_buckets`;
  });

  /** One relay pass, handing log rows to `exporter`. */
  const relay = (exporter: Exporter | null) => relayOnce(t.db, (row) => deliver(row, () => exporter));

  it("answers at full speed while a slow sink takes its time, and the line arrives after", async () => {
    const exporter = conversationLogExporter(t.db, slowSink(fileSink(file), 1500));
    const started = performance.now();
    const response = await ask(deps(chatObserver({}, null, exporter)), "What's the meal limit when travelling?");
    await response.text();
    const answered = performance.now() - started;
    expect(answered).toBeLessThan(1000);
    expect(lines()).toEqual([]);

    const { published } = await relay(exporter);
    expect(published).toHaveLength(1);
    await exporter.idle();
    const [line] = lines();
    expect(line).toMatchObject({
      type: "chat_turn",
      tenantId: tenant,
      userId: LEO,
      question: { text: "What's the meal limit when travelling?" },
      reply: { text: CITED, status: "complete", citations: 1, dropped: 0, abstained: false, flagged: false },
    });
    expect(line.reply.sources).toEqual([{ label: "S1", path: POLICY_V2.path, page: 3 }]);
    const [row] =
      await t.sql`SELECT claimed_by, published_at, attempts FROM outbox WHERE kind = ${CONVERSATION_LOG_KIND}`;
    // One attempt by the relay (the hand-over), one by the exporter (the write).
    expect(row).toMatchObject({ claimed_by: "conversation-log", attempts: 2 });
    expect(row.published_at).not.toBeNull();
  });

  it("writes the log row with the reply, unpublished, for the relay to deliver like any other", async () => {
    const kicks: string[] = [];
    const exporter: Exporter = { kick: () => void kicks.push("kick"), idle: async () => {} };
    await (await ask(deps(chatObserver({}, null, exporter)), "Meals?")).text();
    const [row] = await t.sql`SELECT id, published_at, claimed_by FROM outbox WHERE kind = ${CONVERSATION_LOG_KIND}`;
    expect(row).toMatchObject({ published_at: null, claimed_by: null });
    expect(kicks, "the chat kicks the relay, never the exporter").toEqual([]);

    expect(await relay(exporter)).toMatchObject({ published: [row.id], failed: [] });
    expect(kicks, "delivering the row hands it to the exporter").toEqual(["kick"]);
  });

  it("fails a log row at once where the log is off, since nothing here can ever write it", async () => {
    const observe = chatObserver({}, null, { kick: () => {}, idle: async () => {} });
    await (await ask(deps(observe), "Meals?")).text();
    const { failed } = await relay(null);
    expect(failed).toHaveLength(1);
    const [row] = await t.sql`SELECT attempts, last_error, failed_at FROM outbox WHERE id = ${failed[0]}`;
    expect(row.last_error).toMatch(/^UndeliverableError: the conversation log is off/);
    expect(row.failed_at).not.toBeNull();
  });

  it("exports the row the relay hands over while the relay's transaction still holds it", async () => {
    const exporter = conversationLogExporter(t.db, fileSink(file));
    await (await ask(deps(chatObserver({}, null, exporter)), "Meals?")).text();
    // The relay commits a little after it kicks: an exporter that skipped locked rows would find nothing.
    await relayOnce(t.db, async (row) => {
      await deliver(row, () => exporter);
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await exporter.idle();
    expect(lines().map((l) => l.question.text)).toEqual(["Meals?"]);
  });

  it("keeps the rows when the sink fails, and exports them on the next drain", async () => {
    const observe = chatObserver({}, null, { kick: () => {}, idle: async () => {} });
    await (await ask(deps(observe), "Meals?")).text();
    await (await ask(deps(observe), "Hotels?")).text();
    const broken: Sink = { write: async () => Promise.reject(new Error("bucket unreachable")) };
    expect(await exportConversationLog(t.db, broken)).toEqual({
      exported: 0,
      gone: 0,
      error: "Error: bucket unreachable",
    });
    const pending = await t.sql`SELECT attempts, last_error FROM outbox WHERE claimed_by IS NULL ORDER BY created_at`;
    expect(pending.map((r) => [r.attempts, r.last_error])).toEqual([
      [1, "Error: bucket unreachable"],
      [1, "Error: bucket unreachable"],
    ]);
    expect(await exportConversationLog(t.db, fileSink(file))).toMatchObject({ exported: 2, error: null });
    expect(lines().map((l) => l.question.text)).toEqual(["Meals?", "Hotels?"]);
  });

  it("exports a row the relay published while the sink was down on the next relay pass, with nothing to kick it", async () => {
    const broken: Sink = { write: async () => Promise.reject(new Error("bucket unreachable")) };
    const down = conversationLogExporter(t.db, broken);
    await (await ask(deps(chatObserver({}, null, down)), "Meals?")).text();
    expect((await relay(down)).published).toHaveLength(1);
    await down.idle();
    const [stranded] = await t.sql`SELECT published_at, claimed_by, last_error FROM outbox`;
    expect(stranded, "published by the relay, never claimed: no delivery will come for it again").toMatchObject({
      claimed_by: null,
      last_error: "Error: bucket unreachable",
    });
    expect(stranded.published_at).not.toBeNull();

    // The sink is back. No chat, no kick: only the cron route's (or the dev relay's) next pass.
    const pass = await relayPass(t.db, (row) => deliver(row, () => null), {
      conversationLog: () => conversationLogPass(t.db, fileSink(file)),
    });
    expect(pass).toMatchObject({ published: 0, conversationLog: { exported: 1, error: null } });
    expect(lines().map((l) => l.question.text)).toEqual(["Meals?"]);
    const [row] = await t.sql`SELECT claimed_by FROM outbox`;
    expect(row.claimed_by).toBe("conversation-log");
  });

  it("gives up on a row after its attempts, so a dead sink can't keep a pass busy forever", async () => {
    const observe = chatObserver({}, null, { kick: () => {}, idle: async () => {} });
    await (await ask(deps(observe), "Meals?")).text();
    const broken: Sink = { write: async () => Promise.reject(new Error("bucket unreachable")) };
    for (let i = 0; i < 3; i++) {
      expect(await conversationLogPass(t.db, broken, { maxAttempts: 3 })).toMatchObject({ error: /unreachable/ });
    }
    const [row] = await t.sql`SELECT attempts, failed_at FROM outbox`;
    expect(row.attempts).toBe(3);
    expect(row.failed_at, "out of attempts: failed, and left alone").not.toBeNull();
    expect(await conversationLogPass(t.db, broken, { maxAttempts: 3 })).toEqual({
      batches: 1,
      exported: 0,
      gone: 0,
      error: null,
    });
  });

  it("drains at most its batches a pass, and the next pass carries on", async () => {
    const observe = chatObserver({}, null, { kick: () => {}, idle: async () => {} });
    for (const q of ["Meals?", "Hotels?", "Trains?"]) await (await ask(deps(observe), q)).text();
    const sink = fileSink(file);
    expect(await conversationLogPass(t.db, sink, { batchSize: 1, maxBatches: 2 })).toMatchObject({
      batches: 2,
      exported: 2,
    });
    expect(await conversationLogPass(t.db, sink, { batchSize: 1, maxBatches: 2 })).toMatchObject({ exported: 1 });
    expect(lines().map((l) => l.question.text)).toEqual(["Meals?", "Hotels?", "Trains?"]);
  });

  it("with telemetry on, gives the turn a span with its cost, and counts a rate-limited request", async () => {
    const tel = testTelemetry();
    tel.install();
    try {
      const observe = chatObserver({}, tel, null);
      await (await ask(deps(observe, 1), "Meals?")).text();
      expect((await ask(deps(observe, 1), "Again?")).status).toBe(429);
      const turn = tel.spans().find((s) => s.name === "chat_turn")!;
      expect(turn.attributes).toMatchObject({ "agentic_chat.status": "ok", "agentic_chat.request.model_calls": 1 });
      const metrics = await tel.readMetrics();
      const denials = metrics.get("agentic_chat.denials") as SumMetricData;
      expect(denials.dataPoints.map((p) => [p.attributes["agentic_chat.denial.kind"], p.value])).toEqual([
        ["rate_limit", 1],
      ]);
      const duration = metrics.get("agentic_chat.request.duration") as HistogramMetricData;
      expect(duration.dataPoints[0].attributes).toEqual({
        "agentic_chat.route": "chat_turn",
        "agentic_chat.status": "ok",
      });
    } finally {
      tel.uninstall();
    }
  });
});
