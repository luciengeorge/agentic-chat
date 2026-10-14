// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { RouteInput } from "#learn/agent/router";
import type { Viewer } from "#learn/retrieve/types";

import { routeMessage, ROUTE_TOOL } from "#learn/agent/router";
import { scriptedTurns } from "#learn/model/testing";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { append, loadState } from "@/lib/agent-runs";

import { handleRouteMessage, type RouterRouteDeps } from "./-router";

const LEO = "44444444-4444-4444-8444-444444444444";
const NORA = "55555555-5555-4555-8555-555555555555";

describe.skipIf(!postgresAvailable)("the chat router", () => {
  let t: TestDatabase;
  let leo: Viewer;
  let nora: Viewer;
  let kicked: string[];
  let routed: RouteInput[];

  /** The real `routeMessage` on a scripted model that picks `route`. */
  const deps = (route: "answer" | "agent"): RouterRouteDeps => ({
    runs: {
      db: t.appDb,
      kick: (_viewer, runId) => kicked.push(runId),
      bucket: { name: "agent", capacity: 100, refillPerSecond: 1 },
    },
    bucket: { name: "router", capacity: 100, refillPerSecond: 1 },
    route: (input) => {
      routed.push(input);
      const { model } = scriptedTurns([
        { toolCalls: [{ callId: "r", name: ROUTE_TOOL, input: { route, reason: `scripted ${route}` } }] },
      ]);
      return routeMessage(input, { model, reasoningEffort: "low" });
    },
  });

  const send = (viewer: Viewer, body: Record<string, unknown>, route: "answer" | "agent") =>
    handleRouteMessage(
      new Request("http://localhost:3000/api/chat/router", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      viewer,
      deps(route),
    );
  const message = (text: string) => ({ id: crypto.randomUUID(), text });
  const runsIn = (conversationId: string) =>
    t.sql`SELECT id, status FROM runs WHERE conversation_id = ${conversationId} ORDER BY created_at`;

  beforeAll(async () => {
    t = await createTestDatabase();
    const [{ id: kestrel }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
    for (const [id, name] of [
      [LEO, "leo.martin"],
      [NORA, "nora.diaz"],
    ]) {
      await t.sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, enabled, synced_at)
                  VALUES (${id}, ${kestrel}, 'user', ${id}, ${name}, ${name}, true, now())`;
    }
    leo = { tenantId: kestrel, userId: LEO };
    nora = { tenantId: kestrel, userId: NORA };
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(() => {
    kicked = [];
    routed = [];
  });

  it("leaves a plain question to the RAG answer: no run, no conversation yet", async () => {
    const conversationId = crypto.randomUUID();
    const response = await send(
      leo,
      { conversationId, runId: crypto.randomUUID(), message: message("What's the meal allowance?") },
      "answer",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ route: "answer", reason: "scripted answer" });
    expect(routed).toEqual([{ message: "What's the meal allowance?", liveRun: false }]);
    expect(await t.sql`SELECT 1 FROM conversations WHERE id = ${conversationId}`).toHaveLength(0);
    expect(kicked).toEqual([]);
  });

  it("starts a run in the conversation when the router picks the agent", async () => {
    const conversationId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const response = await send(leo, { conversationId, runId, message: message("Email Tom the terms") }, "agent");
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ route: "agent", followUp: false, id: runId, duplicate: false });
    expect(await runsIn(conversationId)).toEqual([{ id: runId, status: "queued" }]);
    expect(kicked).toEqual([runId]);
  });

  it("skips the router when the composer's toggle asks for the agent", async () => {
    const conversationId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const response = await send(leo, { conversationId, runId, message: message("hi"), agent: true }, "answer");
    expect(await response.json()).toMatchObject({ route: "agent", followUp: false, id: runId });
    expect(routed).toEqual([]);
  });

  it("puts a follow-up into the conversation's live run instead of starting another", async () => {
    const conversationId = crypto.randomUUID();
    const first = crypto.randomUUID();
    await send(leo, { conversationId, runId: first, message: message("Email Tom the terms") }, "agent");
    // The run is waiting on its user, as after an approval request.
    await withTenantOn(t.appDb, leo.tenantId, (tx) =>
      append(tx, first, 1, [
        { type: "status", from: "queued", to: "running" },
        { type: "status", from: "running", to: "waiting" },
      ]),
    );
    kicked = [];
    const followUp = message("Send it to Amara instead");
    const response = await send(leo, { conversationId, runId: crypto.randomUUID(), message: followUp }, "agent");
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ route: "agent", followUp: true, id: first, duplicate: false });
    expect(routed.at(-1)).toEqual({ message: followUp.text, liveRun: true });
    expect(await runsIn(conversationId)).toHaveLength(1);
    const state = await withTenantOn(t.appDb, leo.tenantId, (tx) => loadState(tx, leo, first));
    expect(state!.events.at(-1)!.data).toEqual({ type: "user_message", messageId: followUp.id, text: followUp.text });
    // Waiting, so the runner is woken (the Workflow runner resumes the run's hook).
    expect(kicked).toEqual([first]);
  });

  it("starts a new run once the last one has finished", async () => {
    const conversationId = crypto.randomUUID();
    const done = crypto.randomUUID();
    await send(leo, { conversationId, runId: done, message: message("first") }, "agent");
    await t.sql`UPDATE runs SET status = 'succeeded' WHERE id = ${done}`;
    const next = crypto.randomUUID();
    const response = await send(leo, { conversationId, runId: next, message: message("again") }, "agent");
    expect(await response.json()).toMatchObject({ followUp: false, id: next });
    expect(routed.at(-1)!.liveRun).toBe(false);
  });

  it("answers 404 for another user's conversation", async () => {
    const conversationId = crypto.randomUUID();
    await send(leo, { conversationId, runId: crypto.randomUUID(), message: message("mine"), agent: true }, "agent");
    const response = await send(nora, { conversationId, runId: crypto.randomUUID(), message: message("hi") }, "agent");
    expect(response.status).toBe(404);
  });
});
