// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { RunEvent } from "#learn/agent/types";
import type { Viewer } from "#learn/retrieve/types";

import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { append, loadRun } from "@/lib/agent-runs";

import { handleDecideApproval, handleListApprovals } from "../approvals/-approvals";
import {
  FOLLOW_UP_BUCKET,
  handleAddMessage,
  handleCancelRun,
  handleStartRun,
  handleStream,
  type RunRoutesDeps,
} from "./-runs";

const LEO = "44444444-4444-4444-8444-444444444444";
const NORA = "55555555-5555-4555-8555-555555555555";
const GHOST = "66666666-6666-4666-8666-666666666666";
const NINA = "77777777-7777-4777-8777-777777777777";

interface SseBlock {
  event?: string;
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
        else if (line.startsWith("event: ")) block.event = line.slice(7);
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

const eventsOf = (blocks: SseBlock[]): RunEvent[] =>
  blocks.filter((b) => b.data && !b.event).map((b) => JSON.parse(b.data!));

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
    it("adds a message once per id, and kicks the run's runner, a running one included", async () => {
      const id = await newRun();
      kicked = [];
      expect(await (await say(leo, id, "m2")).json()).toEqual({ id, seq: 2, duplicate: false });
      expect(await (await say(leo, id, "m2")).json()).toEqual({ id, seq: 2, duplicate: true });
      expect(kicked).toEqual([id, id]);

      // A running run's workflow may have died: the kick wakes a live one and replaces a dead one.
      await appendTo(id, { type: "status", from: "queued", to: "running" });
      kicked = [];
      expect((await say(leo, id, "m3")).status).toBe(202);
      expect(kicked).toEqual([id]);
    });

    it("rate-limits follow-ups on the router's bucket", async () => {
      const id = await newRun();
      const d = deps({ messageBucket: { name: "router", capacity: 1, refillPerSecond: 0.01 } });
      const send = (messageId: string) =>
        handleAddMessage(post(`/api/runs/${id}/messages`, { message: { id: messageId, text: "x" } }), leo, id, d);
      expect((await send("f1")).status).toBe(202);
      const refused = await send("f2");
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("100");
      expect(FOLLOW_UP_BUCKET.name).toBe("router");
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

    it("merges a Workflow run's tokens, and drops the late ones of a turn already sent", async () => {
      const id = await newRun();
      await appendTo(id, { type: "status", from: "queued", to: "running" });
      await t.sql`UPDATE runs SET workflow_run_id = 'wrun_test' WHERE id = ${id}`;
      let push!: ReadableStreamDefaultController<{ delta: string; turn: string }>;
      const tokens = new ReadableStream<{ delta: string; turn: string }>({ start: (c) => void (push = c) });
      const asked: string[] = [];
      const d = deps({
        tokens: async (workflowRunId) => {
          asked.push(workflowRunId);
          return tokens;
        },
      });
      const response = await stream(leo, id, {}, d);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const until = async (needle: string) => {
        while (!text.includes(needle)) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`stream ended before ${needle}`);
          text += decoder.decode(value, { stream: true });
        }
      };
      await until("id: 2");
      push.enqueue({ delta: "Hel", turn: "wf:t1" });
      await until('data: {"delta":"Hel"}');
      expect(text).toContain('event: token\ndata: {"delta":"Hel"}\n\n');

      await withTenantOn(t.appDb, kestrel, async (tx) => {
        const run = await loadRun(tx, leo, id);
        return append(
          tx,
          id,
          run!.version,
          [
            {
              type: "assistant_turn",
              text: "Hello",
              toolCalls: [],
              usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
            },
          ],
          {
            stepKey: "wf:t1",
          },
        );
      });
      await until("id: 3");
      push.enqueue({ delta: "lo", turn: "wf:t1" });
      push.enqueue({ delta: "Next", turn: "wf:t2" });
      await until('{"delta":"Next"}');
      expect(text).not.toContain('{"delta":"lo"}');
      expect(asked).toEqual(["wrun_test"]);
      await appendTo(id, { type: "status", from: "running", to: "succeeded" });
      await until("id: 4");
      for (;;) if ((await reader.read()).done) break;
    });

    it("answers 404 for another user's run, another tenant's, or a bad id", async () => {
      const id = await newRun();
      expect((await stream(nora, id)).status).toBe(404);
      expect((await stream(nina, id)).status).toBe(404);
      expect((await stream(leo, "nope")).status).toBe(404);
    });
  });

  /** A run waiting on a `send_mail` approval, written as the runner would. */
  const waitingRun = async () => {
    const runId = await newRun();
    const [{ id: approvalId }] = await t.sql`
      INSERT INTO approvals (tenant_id, run_id, call_id, tool, input, expires_at)
      VALUES (${kestrel}, ${runId}, 'm1', 'send_mail', ${JSON.stringify({ to: "amara@kestrelpay.example" })}::jsonb,
        now() + interval '7 days')
      RETURNING id`;
    await appendTo(
      runId,
      { type: "status", from: "queued", to: "running" },
      {
        type: "approval_requested",
        approvalId,
        call: { callId: "m1", tool: "send_mail", input: {}, screen: { flag: "quotes a document Amara can't read" } },
        expiresAt: new Date().toISOString(),
      },
      { type: "status", from: "running", to: "waiting", reason: "approval" },
    );
    return { runId, approvalId: approvalId as string };
  };

  describe("POST /api/runs/:id/cancel", () => {
    it("cancels the viewer's run once, wakes the runner, and answers 404 to anyone else", async () => {
      const { runId } = await waitingRun();
      const woken: string[] = [];
      const d = deps({ wake: async (_, id, why) => void woken.push(`${id}:${why.kind}`) });
      expect((await handleCancelRun(nora, runId, d)).status).toBe(404);
      expect((await handleCancelRun(nina, runId, d)).status).toBe(404);
      expect((await handleCancelRun(leo, "nope", d)).status).toBe(404);
      const cancelled = await handleCancelRun(leo, runId, d);
      expect(cancelled.status).toBe(202);
      expect(await cancelled.json()).toEqual({ id: runId, status: "cancelled" });
      const again = await handleCancelRun(leo, runId, d);
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: "run_finished", status: "cancelled" });
      expect(woken).toEqual([`${runId}:cancel`]);
    });
  });

  describe("the approval routes", () => {
    const decide = (viewer: Viewer, id: string, body: unknown, d = deps()) =>
      handleDecideApproval(post(`/api/approvals/${id}`, body), viewer, id, d);
    const list = (viewer: Viewer, query = "") =>
      handleListApprovals(new Request(`http://localhost:3000/api/approvals${query}`), viewer, deps());

    it("lists the viewer's pending approvals and nobody else's", async () => {
      const { approvalId, runId } = await waitingRun();
      const mine = await list(leo, "?status=pending");
      expect(mine.status).toBe(200);
      const { approvals } = (await mine.json()) as { approvals: { id: string; runId: string }[] };
      expect(approvals).toContainEqual(
        expect.objectContaining({
          id: approvalId,
          runId,
          tool: "send_mail",
          screen: { flag: "quotes a document Amara can't read" },
        }),
      );
      expect(await (await list(nora, "?status=pending")).json()).toEqual({ approvals: [] });
      expect((await list(leo, "?status=approved")).status).toBe(400);
    });

    it("decides once, wakes the runner, and refuses bad bodies, strangers and a second decision", async () => {
      const { approvalId, runId } = await waitingRun();
      const woken: string[] = [];
      const d = deps({ wake: async (_, id, why) => void woken.push(`${id}:${why.kind}`) });
      expect((await decide(leo, approvalId, "{", d)).status).toBe(400);
      expect((await decide(leo, approvalId, { decision: "maybe" }, d)).status).toBe(400);
      expect((await decide(nora, approvalId, { decision: "approved" }, d)).status).toBe(404);
      expect((await decide(nina, approvalId, { decision: "approved" }, d)).status).toBe(404);
      expect((await decide(leo, "nope", { decision: "approved" }, d)).status).toBe(404);
      const ok = await decide(leo, approvalId, { decision: "approved" }, d);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ id: approvalId, decision: "approved" });
      const again = await decide(leo, approvalId, { decision: "rejected" }, d);
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: "not_pending" });
      expect(woken).toEqual([`${runId}:approval`]);
    });
  });
});

// Every runs, approvals and memory route goes through the viewer middleware, and no schema takes a tenant or a user id.
describe("the runs boundary", () => {
  const dirs = [
    join(import.meta.dirname),
    join(import.meta.dirname, "../memory"),
    join(import.meta.dirname, "../approvals"),
  ];
  const files = dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => /\.tsx?$/.test(name) && !name.includes(".test."))
      .map((name) => join(dir, name)),
  );
  const read = (path: string) => readFileSync(path, "utf8");

  it("puts every route behind the middleware", () => {
    const routes = files.filter((path) => /\bserver:\s*\{/.test(read(path)));
    expect(routes.length).toBe(8);
    for (const path of routes) expect(read(path)).toMatch(/server:\s*\{\s*middleware:\s*\[viewerMiddleware\]/);
  });

  it("takes no tenant or user from the request", () => {
    expect(read(join(import.meta.dirname, "-runs.ts"))).not.toMatch(/tenantId:\s*z\.|userId:\s*z\./);
  });
});
