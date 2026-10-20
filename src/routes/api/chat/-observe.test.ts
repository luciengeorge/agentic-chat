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
import { testTelemetry } from "#learn/observability/testing";
import { relayOnce } from "#learn/queue/outbox";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { chatObserver } from "@/lib/observability.server";

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

  it("answers at full speed while a slow sink takes its time, and the line arrives after", async () => {
    const exporter = conversationLogExporter(t.db, slowSink(fileSink(file), 1500));
    const started = performance.now();
    const response = await ask(deps(chatObserver({}, null, exporter)), "What's the meal limit when travelling?");
    await response.text();
    const answered = performance.now() - started;
    expect(answered).toBeLessThan(1000);
    expect(lines()).toEqual([]);

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
    expect(row).toMatchObject({ claimed_by: "conversation-log", attempts: 1 });
    expect(row.published_at).not.toBeNull();
  });

  it("writes the log row with the reply, and the relay that starts workflows never picks it up", async () => {
    const observe = chatObserver({}, null, { kick: () => {}, idle: async () => {} });
    await (await ask(deps(observe), "Meals?")).text();
    const delivered: string[] = [];
    await relayOnce(t.db, async (row) => void delivered.push(row.kind));
    expect(delivered).toEqual([]);
    const [{ count }] =
      await t.sql`SELECT count(*)::int AS count FROM outbox WHERE kind = ${CONVERSATION_LOG_KIND} AND claimed_by IS NULL`;
    expect(count).toBe(1);
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
