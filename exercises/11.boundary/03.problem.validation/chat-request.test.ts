// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ChatRequestSchema, MAX_BODY_BYTES, readChatTurn, type ChatTurn } from "#learn/boundary/chat-request";
import { scriptedModel } from "#learn/model/testing";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { handleChat } from "@/routes/api/chat/-chat";

const KESTREL = { tenantId: "11111111-1111-4111-8111-111111111111", userId: "44444444-4444-4444-8444-444444444444" };
const HARBOUR = { tenantId: "22222222-2222-4222-8222-222222222222", userId: "55555555-5555-4555-8555-555555555555" };
const CONVERSATION = "7f3c9a1e-2b4d-4c8e-9f10-3a5b6c7d8e9f";
const QUESTION = "What is the hotel limit for a night in London?";

/** What useChat sends for one question: the conversation id and the newest message, with its 16-character id. */
const body = (text = QUESTION, extra: Record<string, unknown> = {}) => ({
  id: CONVERSATION,
  message: { id: "Xq3vL9tRk2PwN8sD", role: "user", parts: [{ type: "text", text }] },
  ...extra,
});

const post = (payload: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

async function refused(
  payload: unknown,
  headers?: Record<string, string>,
  what = JSON.stringify(payload).slice(0, 80),
) {
  const result = await readChatTurn(post(payload, headers), KESTREL);
  expect(result, `${what}: expected a refusal, got a turn`).toBeInstanceOf(Response);
  const response = result as Response;
  return { status: response.status, error: ((await response.json()) as { error: string }).error };
}

async function turn(payload: unknown): Promise<ChatTurn> {
  const result = await readChatTurn(post(payload), KESTREL);
  if (result instanceof Response) expect.fail(`refused with ${result.status} ${await result.text()}`);
  return result;
}

describe("reading a chat request", () => {
  it("reads the body useChat sends as a turn for the session's viewer", async () => {
    expect(await turn(body())).toEqual({
      scope: KESTREL,
      conversationId: CONVERSATION,
      messageKey: "Xq3vL9tRk2PwN8sD",
      question: QUESTION,
    });
  });

  it("joins text parts with a newline and trims the question", async () => {
    const twoParts = body();
    twoParts.message.parts = [
      { type: "text", text: "  What is the hotel limit" },
      { type: "text", text: "for a night in London?  " },
    ];
    expect((await turn(twoParts)).question).toBe("What is the hotel limit\nfor a night in London?");
  });

  it("refuses what isn't JSON, and every shape the schema doesn't allow", async () => {
    expect(await refused("{nope")).toEqual({ status: 400, error: "invalid_json" });
    const shapes: Array<[string, unknown]> = [
      ["a conversation id that isn't a uuid", { ...body(), id: "conversation-1" }],
      ["a message id with a space", { ...body(), message: { ...body().message, id: "has space" } }],
      ["a message id over 64 characters", { ...body(), message: { ...body().message, id: "x".repeat(65) } }],
      ["an assistant message", { ...body(), message: { ...body().message, role: "assistant" } }],
      ["a part that isn't text", { ...body(), message: { ...body().message, parts: [{ type: "file", url: "x" }] } }],
      ["no parts", { ...body(), message: { ...body().message, parts: [] } }],
      ["nine parts", { ...body(), message: { ...body().message, parts: Array(9).fill({ type: "text", text: "hi" }) } }],
      ["no message", { id: CONVERSATION }],
    ];
    for (const [what, shape] of shapes) {
      expect(await refused(shape, undefined, what), `${what}: 400 invalid_request`).toEqual({
        status: 400,
        error: "invalid_request",
      });
    }
    const response = (await readChatTurn(post({ ...body(), id: "nope" }), KESTREL)) as Response;
    expect(await response.json(), "say which field").toMatchObject({ issues: { id: expect.any(Array) } });
  });

  it("refuses an empty question, and one over 4,000 characters", async () => {
    expect(await refused(body("   \n  "), undefined, "a question of spaces (trim it)")).toEqual({
      status: 400,
      error: "empty_question",
    });
    expect(await refused(body("x".repeat(4001)))).toEqual({ status: 400, error: "question_too_long" });
    expect((await turn(body("x".repeat(4000)))).question, "4,000 is allowed").toHaveLength(4000);
  });

  it("refuses a body its content-length says is too big, without reading it", async () => {
    const request = post(body(), { "content-length": String(MAX_BODY_BYTES + 1) });
    const result = (await readChatTurn(request, KESTREL)) as Response;
    expect(result.status).toBe(413);
    expect(request.bodyUsed, "check the header before you read the body: reading it is the cost you're refusing").toBe(
      false,
    );
  });

  it("refuses a body that turns out too big once read, whatever the header said", async () => {
    expect(
      await refused(body("x".repeat(MAX_BODY_BYTES)), { "content-length": "10" }),
      "measure what you read",
    ).toEqual({ status: 413, error: "too_large" });
  });

  it("measures the body in bytes, not characters", async () => {
    // 33,000 "£" signs: about 33,170 characters of JSON, but 66,170 bytes of UTF-8.
    const pounds = body("£".repeat(33_000));
    expect(JSON.stringify(pounds).length).toBeLessThan(MAX_BODY_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(pounds)).byteLength).toBeGreaterThan(MAX_BODY_BYTES);
    expect(
      await refused(pounds, { "content-length": "10" }),
      "£ is one character and two bytes: a string's length undercounts, so count the bytes you read",
    ).toEqual({ status: 413, error: "too_large" });
  });

  it("names no tenant and no user: the schema describes only the conversation and the message", () => {
    expect(Object.keys(ChatRequestSchema.shape).sort()).toEqual(["id", "message"]);
    expect(Object.keys(ChatRequestSchema.shape.message.shape).sort()).toEqual(["id", "parts", "role"]);
  });

  it("acts for the session's viewer even when the body names another tenant and user", async () => {
    const result = await readChatTurn(
      post(body(QUESTION, { tenantId: HARBOUR.tenantId, userId: HARBOUR.userId })),
      KESTREL,
    );
    if (!(result instanceof Response)) {
      expect(result.scope, "the scope is the viewer the middleware loaded, never the body's").toEqual(KESTREL);
    } else {
      expect(result.status, "refusing the extra keys is fine too").toBe(400);
    }
  });
});

describe.skipIf(!postgresAvailable)("Leo's request through POST /api/chat", () => {
  let t: TestDatabase;
  let kestrel: string;
  let harbour: string;
  const leo = "44444444-4444-4444-8444-444444444444";

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: kestrel }, { id: harbour }] = await t.sql`
      INSERT INTO organization (name, slug, created_at)
      VALUES ('Kestrel Pay', 'kestrel', now()), ('Harbour Health', 'harbour', now()) RETURNING id`;
    await t.sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, enabled, synced_at)
                VALUES (${leo}, ${kestrel}, 'user', ${leo}, 'leo.martin', 'Leo Martin', true, now())`;
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("stores his conversation in Kestrel though the body says Harbour, from a 177-byte request", async () => {
    const raw = JSON.stringify(body());
    expect(new TextEncoder().encode(raw).length, "the body useChat sends for his question").toBe(177);

    const tampered = JSON.stringify(body(QUESTION, { tenantId: harbour }));
    const response = await handleChat(
      post(tampered),
      { tenantId: kestrel, userId: leo },
      {
        db: t.appDb,
        retrieve: async (_viewer, query) => ({ query, rewritten: [], chunks: [], auditId: "a" }),
        model: scriptedModel("never").model,
        reasoningEffort: "medium",
        bucket: { name: "chat", capacity: 10, refillPerSecond: 10 / 60 },
      },
    );
    if (response.status === 200) await response.text();
    expect([200, 400], "answered, or refused for the extra key").toContain(response.status);
    if (response.status === 200) {
      expect(await t.sql`SELECT tenant_id FROM conversations WHERE id = ${CONVERSATION}`).toEqual([
        { tenant_id: kestrel },
      ]);
    }
    expect(await t.sql`SELECT count(*)::int AS n FROM conversations WHERE tenant_id = ${harbour}`).toEqual([{ n: 0 }]);
  });
});
