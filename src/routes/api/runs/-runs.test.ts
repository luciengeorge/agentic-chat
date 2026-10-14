// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { RunEvent } from "#learn/agent/types";
import type { Viewer } from "#learn/retrieve/types";

import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { append, loadRun } from "@/lib/agent-runs";

import { handleAddMessage, handleStartRun, handleStream, type RunRoutesDeps } from "./-runs";

const LEO = "44444444-4444-4444-8444-444444444444";
const NORA = "55555555-5555-4555-8555-555555555555";
const GHOST = "66666666-6666-4666-8666-666666666666";
const NINA = "77777777-7777-4777-8777-777777777777";

interface SseBlock {
  id?: string;
  data?: string;
  comment?: string;
}

/** Reads SSE blocks until `stop` says enough, or the stream ends. */
async function readSse(response: Response, stop: (blocks: SseBlock[]) => boolean = () => false) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const blocks: SseBlock[] = [];
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return { blocks, ended: true };
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block: SseBlock = {};
      for (const line of buffer.slice(0, end).split("\n")) {
        if (line.startsWith(":")) block.comment = line.slice(1).trim();
        else if (line.startsWith("id: ")) block.id = line.slice(4);
        else if (line.startsWith("data: ")) block.data = line.slice(6);
      }
      buffer = buffer.slice(end + 2);
      blocks.push(block);
    }
    if (stop(blocks)) {
      await reader.cancel();
      return { blocks, ended: false };
    }
  }
}

const eventsOf = (blocks: SseBlock[]): RunEvent[] => blocks.filter((b) => b.data).map((b) => JSON.parse(b.data!));

describe.skipIf(!postgresAvailable)("the run routes", () => {
  let t: TestDatabase;
  let kestrel: string;
  let leo: Viewer;
  let nora: Viewer;
  let nina: Viewer;
  let kicked: string[];

  const deps = (overrides: Partial<RunRoutesDeps> = {}): RunRoutesDeps => ({
    db: t.appDb,
    kick: (_viewer, runId) => kicked.push(runId),
    bucket: { name: "agent", capacity: 100, refillPerSecond: 1 },
    pollMs: 10,
    ...overrides,
  });

  const post = (url: string, body: unknown) =>
    new Request(`http://localhost:3000${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  const start = (viewer: Viewer, body: unknown, d = deps()) => handleStartRun(post("/api/runs", body), viewer, d);
  const say = (viewer: Viewer, runId: string, id: string, text = "and another thing") =>
    handleAddMessage(post(`/api/runs/${runId}/messages`, { message: { id, text } }), viewer, runId, deps());
  const stream = (viewer: Viewer, runId: string, headers: HeadersInit = {}, d = deps(), query = "") =>
    handleStream(new Request(`http://localhost:3000/api/runs/${runId}/stream${query}`, { headers }), viewer, runId, d);

  const newRun = async (viewer = leo) => {
    const id = crypto.randomUUID();
    expect((await start(viewer, { id, message: { id: "m1", text: "hello" } })).status).toBe(202);
    return id;
  };

  const appendTo = (runId: string, ...events: Parameters<typeof append>[3]) =>
    withTenantOn(t.appDb, kestrel, async (tx) => {
      const run = await loadRun(tx, leo, runId);
      return append(tx, runId, run!.version, events);
    });

  beforeAll(async () => {
    t = await createTestDatabase();
    const [{ id: k }, { id: harbour }] = await t.sql`
      INSERT INTO organization (name, slug, created_at)
      VALUES ('Kestrel Pay', 'kestrel', now()), ('Harbour Health', 'harbour', now())
      RETURNING id`;
    kestrel = k;
    for (const [id, tenant, name] of [
      [LEO, kestrel, "leo.martin"],
      [NORA, kestrel, "nora.kim"],
      [NINA, harbour, "nina.osei"],
    ]) {
      await t.sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, enabled, synced_at)
                  VALUES (${id}, ${tenant}, 'user', ${id}, ${name}, ${name}, true, now())`;
    }
    leo = { tenantId: kestrel, userId: LEO };
    nora = { tenantId: kestrel, userId: NORA };
    nina = { tenantId: harbour, userId: NINA };
  });

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    kicked = [];
    await t.sql`DELETE FROM rate_limit_buckets`;
  });

  describe("POST /api/runs", () => {
    it("starts a run with its message, kicks the runner, and makes one run however often it's sent", async () => {
      const id = crypto.randomUUID();
      const body = { id, message: { id: "m1", text: "Find the expenses policy" } };
      const first = await start(leo, body);
      expect(first.status).toBe(202);
      expect(await first.json()).toEqual({ id, seq: 1, duplicate: false });
      expect(await (await start(leo, body)).json()).toEqual({ id, seq: 1, duplicate: true });
      expect(kicked).toEqual([id, id]);
      expect(await t.sql`SELECT user_id, status, kind FROM runs WHERE id = ${id}`).toEqual([
        { user_id: LEO, status: "queued", kind: "chat" },
      ]);
      expect(await t.sql`SELECT seq, type FROM run_events WHERE run_id = ${id}`).toEqual([
        { seq: 1, type: "user_message" },
      ]);
    });

    it("answers 404 to a run id someone else holds", async () => {
      const id = await newRun();
      expect((await start(nora, { id, message: { id: "x", text: "mine" } })).status).toBe(404);
      expect((await start(nina, { id, message: { id: "x", text: "mine" } })).status).toBe(404);
    });

    it("validates the body, and never takes a tenant or user from it", async () => {
      expect((await start(leo, "{")).status).toBe(400);
      expect((await start(leo, { id: "nope", message: { id: "m", text: "x" } })).status).toBe(400);
      expect((await start(leo, { id: crypto.randomUUID(), message: { id: "m", text: "   " } })).status).toBe(400);
      expect((await start(leo, { id: crypto.randomUUID(), message: { id: "m", text: "x".repeat(4001) } })).status).toBe(
        400,
      );
      const id = crypto.randomUUID();
      await start(leo, { id, tenantId: crypto.randomUUID(), userId: NORA, message: { id: "m", text: "hi" } });
      expect(await t.sql`SELECT tenant_id, user_id FROM runs WHERE id = ${id}`).toEqual([
        { tenant_id: kestrel, user_id: LEO },
      ]);
    });

    it("rate-limits starts, and refuses a user the directory hasn't synced", async () => {
      const d = deps({ bucket: { name: "agent", capacity: 1, refillPerSecond: 0.001 } });
      expect((await start(leo, { id: crypto.randomUUID(), message: { id: "m", text: "a" } }, d)).status).toBe(202);
      const limited = await start(leo, { id: crypto.randomUUID(), message: { id: "m", text: "b" } }, d);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
      const ghost = { tenantId: kestrel, userId: GHOST };
      expect((await start(ghost, { id: crypto.randomUUID(), message: { id: "m", text: "a" } })).status).toBe(403);
    });

    it("only links a conversation of the viewer's", async () => {
      const [{ id: conversationId }] = await t.sql`
        INSERT INTO conversations (tenant_id, user_id) VALUES (${kestrel}, ${NORA}) RETURNING id`;
      const body = { id: crypto.randomUUID(), conversationId, message: { id: "m", text: "hi" } };
      expect((await start(leo, body)).status).toBe(404);
      expect((await start(nora, body)).status).toBe(202);
    });
  });

  describe("POST /api/runs/:id/messages", () => {
    it("adds a message once per id, and kicks a waiting run", async () => {
      const id = await newRun();
      kicked = [];
      expect(await (await say(leo, id, "m2")).json()).toEqual({ id, seq: 2, duplicate: false });
      expect(await (await say(leo, id, "m2")).json()).toEqual({ id, seq: 2, duplicate: true });
      expect(kicked).toEqual([id, id]);

      await appendTo(id, { type: "status", from: "queued", to: "running" });
      kicked = [];
      expect((await say(leo, id, "m3")).status).toBe(202);
      expect(kicked).toEqual([]);
    });

    it("answers 404 for another user's or tenant's run, or a bad id, and 409 for a finished run", async () => {
      const id = await newRun();
      expect((await say(nora, id, "x")).status).toBe(404);
      expect((await say(nina, id, "x")).status).toBe(404);
      expect((await say(leo, "not-a-uuid", "x")).status).toBe(404);
      await appendTo(id, { type: "status", from: "queued", to: "cancelled" });
      const finished = await say(leo, id, "late");
      expect(finished.status).toBe(409);
      expect(await finished.json()).toEqual({ error: "run_finished", status: "cancelled" });
    });
  });

  describe("GET /api/runs/:id/stream", () => {
    it("sends the log with id = seq and ends once the run is final", async () => {
      const id = await newRun();
      await appendTo(
        id,
        { type: "status", from: "queued", to: "running" },
        { type: "status", from: "running", to: "succeeded" },
      );
      const response = await stream(leo, id);
      expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      const { blocks, ended } = await readSse(response);
      expect(ended).toBe(true);
      const events = eventsOf(blocks);
      expect(blocks.filter((b) => b.data).map((b) => b.id)).toEqual(["1", "2", "3"]);
      expect(events.map((e) => [e.seq, e.data.type])).toEqual([
        [1, "user_message"],
        [2, "status"],
        [3, "status"],
      ]);
    });

    it("resumes after Last-Event-ID (or ?after=) with only what was missed", async () => {
      const id = await newRun();
      await appendTo(
        id,
        { type: "status", from: "queued", to: "running" },
        {
          type: "assistant_turn",
          text: "hi",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
        },
        { type: "status", from: "running", to: "succeeded" },
      );
      const resumed = eventsOf((await readSse(await stream(leo, id, { "last-event-id": "2" }))).blocks);
      expect(resumed.map((e) => e.seq)).toEqual([3, 4]);
      const byQuery = eventsOf((await readSse(await stream(leo, id, {}, deps(), "?after=3"))).blocks);
      expect(byQuery.map((e) => e.seq)).toEqual([4]);
      // A header that isn't a seq starts from the top.
      const junk = eventsOf((await readSse(await stream(leo, id, { "last-event-id": "abc" }))).blocks);
      expect(junk.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    });

    it("tails events appended while it's open, with heartbeats while it's quiet", async () => {
      const id = await newRun();
      const response = await stream(leo, id, {}, deps({ heartbeatMs: 20 }));
      const reading = readSse(response, (blocks) => eventsOf(blocks).length >= 3);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await appendTo(id, { type: "status", from: "queued", to: "running" });
      await appendTo(id, { type: "status", from: "running", to: "waiting" });
      const { blocks } = await reading;
      expect(eventsOf(blocks).map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(blocks.some((b) => b.comment === "heartbeat")).toBe(true);
    });

    it("answers 404 for another user's run, another tenant's, or a bad id", async () => {
      const id = await newRun();
      expect((await stream(nora, id)).status).toBe(404);
      expect((await stream(nina, id)).status).toBe(404);
      expect((await stream(leo, "nope")).status).toBe(404);
    });
  });
});

// Every runs and memory route goes through the viewer middleware, and no schema takes a tenant or a user id.
describe("the runs boundary", () => {
  const dirs = [join(import.meta.dirname), join(import.meta.dirname, "../memory")];
  const files = dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => /\.tsx?$/.test(name) && !name.includes(".test."))
      .map((name) => join(dir, name)),
  );
  const read = (path: string) => readFileSync(path, "utf8");

  it("puts every route behind the middleware", () => {
    const routes = files.filter((path) => /\bserver:\s*\{/.test(read(path)));
    expect(routes.length).toBe(5);
    for (const path of routes) expect(read(path)).toMatch(/server:\s*\{\s*middleware:\s*\[viewerMiddleware\]/);
  });

  it("takes no tenant or user from the request", () => {
    expect(read(join(import.meta.dirname, "-runs.ts"))).not.toMatch(/tenantId:\s*z\.|userId:\s*z\./);
  });
});
