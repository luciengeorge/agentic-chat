// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Retrieve, RetrievedChunk } from "#learn/retrieve/types";

import { ABSTAIN_TEXT } from "#learn/generate/prompt";
import { parseSse } from "#learn/model/responses";
import { scriptedModel } from "#learn/model/testing";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { handleChat, withHeartbeat, type ChatDeps } from "./-chat";

const LEO = "44444444-4444-4444-8444-444444444444";
const NORA = "55555555-5555-4555-8555-555555555555";
const GHOST = "66666666-6666-4666-8666-666666666666";

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

type UIChunk = { type: string; [key: string]: unknown };

async function chunksOf(response: Response): Promise<UIChunk[]> {
  const out: UIChunk[] = [];
  for await (const { data } of parseSse(response.body!)) if (data !== "[DONE]") out.push(JSON.parse(data));
  return out;
}

const textOf = (chunks: UIChunk[]) =>
  chunks
    .filter((c) => c.type === "text-delta")
    .map((c) => c.delta)
    .join("");

describe.skipIf(!postgresAvailable)("POST /api/chat", () => {
  let t: TestDatabase;
  let tenant: string;
  let retrieved: RetrievedChunk[];
  let retrieveCalls: string[];

  const retrieve: Retrieve = async (_viewer, query) => {
    retrieveCalls.push(query);
    return { query, rewritten: [], chunks: retrieved, auditId: "audit-1" };
  };

  const deps = (overrides: Partial<ChatDeps> = {}): ChatDeps => ({
    db: t.appDb,
    retrieve,
    model: scriptedModel(CITED).model,
    reasoningEffort: "medium",
    bucket: { name: "chat", capacity: 100, refillPerSecond: 1 },
    ...overrides,
  });

  const post = (body: unknown, userId = LEO, d = deps(), init: RequestInit = {}) =>
    handleChat(
      new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
        ...init,
      }),
      { tenantId: tenant, userId },
      d,
    );

  let n = 0;
  const ask = (text: string, conversationId = crypto.randomUUID(), messageId = `m${++n}`) => ({
    id: conversationId,
    message: { id: messageId, role: "user", parts: [{ type: "text", text }] },
  });

  const stored = (conversationId: string) =>
    t.sql`SELECT role, seq, idempotency_key, content FROM messages WHERE conversation_id = ${conversationId} ORDER BY seq`;

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: tenant }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
    for (const [id, name] of [
      [LEO, "leo.martin"],
      [NORA, "nora.kim"],
    ]) {
      await t.sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, enabled, synced_at)
                  VALUES (${id}, ${tenant}, 'user', ${id}, ${name}, ${name}, true, now())`;
    }
  });

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    retrieved = [POLICY_V2];
    retrieveCalls = [];
    await t.sql`DELETE FROM rate_limit_buckets`;
  });

  it("refuses a body that isn't the schema, before any work", async () => {
    for (const body of [
      "{nope",
      { id: "not-a-uuid", message: { id: "m", role: "user", parts: [{ type: "text", text: "hi" }] } },
      { id: crypto.randomUUID(), message: { id: "has space", role: "user", parts: [{ type: "text", text: "hi" }] } },
      { id: crypto.randomUUID(), message: { id: "m", role: "assistant", parts: [{ type: "text", text: "hi" }] } },
      ask("   "),
      ask("x".repeat(4001)),
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(retrieveCalls).toEqual([]);
  });

  it("streams sources, the answer and a verdict, and stores both turns", async () => {
    const { model, mock } = scriptedModel(CITED);
    const body = ask("What's the meal limit when travelling?");
    const response = await post(body, LEO, deps({ model }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const chunks = await chunksOf(response);
    expect(chunks[0]).toMatchObject({ type: "start" });
    expect(chunks.find((c) => c.type === "data-sources")).toMatchObject({
      data: { sources: [{ label: "S1", chunkId: POLICY_V2.id, documentId: POLICY_V2.documentId, pageStart: 3 }] },
    });
    expect(textOf(chunks)).toBe(CITED);
    expect(chunks.find((c) => c.type === "data-verdict")).toMatchObject({
      data: { flagged: false, abstained: false, citations: [{ label: "S1", page: 3 }] },
    });
    expect(chunks.at(-1)).toMatchObject({ type: "finish" });
    expect(mock.doStreamCalls[0].reasoning).toBe("medium");

    const rows = await stored(body.id);
    expect(rows.map((r) => [r.role, r.seq, r.idempotency_key])).toEqual([
      ["user", 1, body.message.id],
      ["assistant", 2, `reply:${body.message.id}`],
    ]);
    expect(rows[1].content).toMatchObject({ text: CITED, status: "complete", auditId: "audit-1" });
    // The assistant's id in the stream is its row id, so a reload finds the same message.
    const [{ id }] = await t.sql`SELECT id FROM messages WHERE idempotency_key = ${`reply:${body.message.id}`}`;
    expect(chunks[0].messageId).toBe(id);
  });

  it("abstains on an empty retrieval without calling the model", async () => {
    retrieved = [];
    const { model, mock } = scriptedModel("never");
    const chunks = await chunksOf(await post(ask("Tell me about Project Heron"), LEO, deps({ model })));
    expect(mock.doStreamCalls).toHaveLength(0);
    expect(textOf(chunks)).toBe(ABSTAIN_TEXT);
    expect(chunks.find((c) => c.type === "data-verdict")).toMatchObject({ data: { abstained: true, flagged: false } });
  });

  it("drops a made-up citation and flags the answer", async () => {
    const { model } = scriptedModel(
      'It is £45 [[S1: "reimbursed up to £45 per day"]] or £90 [[S4: "up to £90 a day"]].',
    );
    const chunks = await chunksOf(await post(ask("Meal limit?"), LEO, deps({ model })));
    expect(chunks.find((c) => c.type === "data-verdict")).toMatchObject({
      data: { flagged: true, citations: [{ label: "S1" }], dropped: [{ label: "S4", reason: "unknown-source" }] },
    });
  });

  it("answers 429 with Retry-After once the user's bucket is empty, before retrieval or the model", async () => {
    const { model, mock } = scriptedModel(CITED);
    const d = deps({ model, bucket: { name: "chat", capacity: 2, refillPerSecond: 0.1 }, now: () => new Date(0) });
    expect((await post(ask("one"), LEO, d)).status).toBe(200);
    expect((await post(ask("two"), LEO, d)).status).toBe(200);
    const refused = await post(ask("three"), LEO, d);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("10");
    expect(await refused.json()).toEqual({ error: "rate_limited", retryAfterSeconds: 10 });
    expect(retrieveCalls).toEqual(["one", "two"]);
    // Another user's bucket is their own.
    expect((await post(ask("four"), NORA, d)).status).toBe(200);
    void mock;
  });

  it("replays the stored reply for a retried message instead of answering twice", async () => {
    const { model, mock } = scriptedModel(CITED);
    const body = ask("Meal limit?");
    const first = await chunksOf(await post(body, LEO, deps({ model })));
    const again = await chunksOf(await post(body, LEO, deps({ model })));
    expect(mock.doStreamCalls).toHaveLength(1);
    expect(textOf(again)).toBe(CITED);
    expect(again[0].messageId).toBe(first[0].messageId);
    expect((await stored(body.id)).map((r) => r.role)).toEqual(["user", "assistant"]);
  });

  it("keeps earlier turns as history for the next question", async () => {
    const conversation = crypto.randomUUID();
    await chunksOf(await post(ask("Meal limit?", conversation)));
    const { model, mock } = scriptedModel(CITED);
    await chunksOf(await post(ask("And for hotels?", conversation), LEO, deps({ model })));
    const roles = mock.doStreamCalls[0].prompt.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
    expect((await stored(conversation)).map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  });

  it("answers 404 for another user's conversation", async () => {
    const conversation = crypto.randomUUID();
    await chunksOf(await post(ask("Mine", conversation), LEO));
    const response = await post(ask("Theirs?", conversation), NORA);
    expect(response.status).toBe(404);
    expect((await stored(conversation)).map((r) => r.role)).toEqual(["user", "assistant"]);
  });

  it("answers 403 for a signed-in user the directory hasn't synced", async () => {
    expect((await post(ask("Hello?"), GHOST)).status).toBe(403);
  });

  it("stops the model when the client aborts, and stores what was sent as stopped", async () => {
    const { model, mock } = scriptedModel("word ".repeat(200), { pieceSize: 5, chunkDelayInMs: 5 });
    const controller = new AbortController();
    const body = ask("Long answer please");
    const response = await post(body, LEO, deps({ model }), { signal: controller.signal });
    const reader = response.body!.getReader();
    let received = "";
    while (!received.includes('"text-delta"')) received += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    await reader.cancel();

    await expect.poll(async () => (await stored(body.id)).length, { timeout: 2000 }).toBe(2);
    const [, reply] = await stored(body.id);
    expect(reply.content.status).toBe("aborted");
    expect(reply.content.text.length).toBeLessThan("word ".repeat(200).length);
    expect(mock.doStreamCalls).toHaveLength(1);
  });

  it("sends heartbeats while the answer is quiet", async () => {
    const slow: Retrieve = async (viewer, query) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return retrieve(viewer, query);
    };
    const response = await post(ask("Slow one"), LEO, deps({ retrieve: slow, heartbeatMs: 10 }));
    const text = await response.text();
    expect(text).toContain(": heartbeat\n\n");
    expect(text).toContain('"type":"finish"');
  });
});

describe("withHeartbeat", () => {
  it("passes chunks through whole and calls onCancel when the reader cancels", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
      },
    });
    const reader = withHeartbeat(source, 1000, () => (cancelled = true)).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 1\n\n");
    await reader.cancel();
    expect(cancelled).toBe(true);
  });
});
