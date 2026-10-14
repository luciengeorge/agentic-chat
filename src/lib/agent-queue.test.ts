// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import type { AgentTool } from "#learn/agent/types";
import type { ChatModel } from "#learn/model/types";
import type { Viewer } from "#learn/retrieve/types";

import { scriptedTurns } from "#learn/model/testing";
import { claim, reclaimExpired } from "#learn/queue/queue";
import { workOnce } from "#learn/queue/worker";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { AGENT_QUEUE, type AgentJob, agentJobHandler, enqueueStep } from "./agent-queue";
import { createRunnerLoop, decideApproval, loadState, startRun } from "./agent-runs";

const LEO = "44444444-4444-4444-8444-444444444444";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A mail tool that sends once per idempotency key, as fake-workspace does. `hangOnce` holds the first send in
 * flight until its signal aborts, as a worker killed mid-call would leave it. */
function mailTool(sent: Map<string, number>, hangOnce = false): AgentTool {
  let hung = !hangOnce;
  return {
    name: "send_mail",
    description: "send mail",
    input: z.object({ to: z.string() }),
    effect: "write",
    needsApproval: () => true,
    execute: async (_, ctx) => {
      sent.set(ctx.idempotencyKey, (sent.get(ctx.idempotencyKey) ?? 0) + 1);
      if (!hung) {
        hung = true;
        await new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason)));
      }
      return { sent: true };
    },
  };
}

describe.skipIf(!postgresAvailable)("the queue runner", () => {
  let t: TestDatabase;
  let leo: Viewer;

  const handlerFor = (model: ChatModel, tools: AgentTool[], approvalTtlMs?: number) =>
    agentJobHandler(() => ({
      db: t.appDb,
      approvalTtlMs,
      loop: (viewer) => ({
        ...createRunnerLoop(viewer, { model, tools, reasoningEffort: "medium" }),
        compact: async () => null,
      }),
    }));
  const options = (handler: ReturnType<typeof agentJobHandler>) => ({
    db: t.db,
    queue: AGENT_QUEUE,
    handler,
    retryInMs: () => 0,
  });
  /** Works due jobs until none is left. */
  const drain = async (handler: ReturnType<typeof agentJobHandler>) => {
    let jobs = 0;
    while (await workOnce<AgentJob>(options(handler))) jobs++;
    return jobs;
  };
  const state = async (runId: string) =>
    (await withTenantOn(t.appDb, leo.tenantId, (tx) => loadState(tx, leo, runId)))!;
  const start = async (text = "mail amara") => {
    const runId = crypto.randomUUID();
    await startRun(t.appDb, leo, { runId, message: { messageId: "m1", text } });
    await withTenantOn(t.appDb, leo.tenantId, (tx) => enqueueStep(tx, leo, runId));
    return runId;
  };
  const approvalOf = async (runId: string) =>
    ((await state(runId)).events.find((e) => e.data.type === "approval_requested")!.data as { approvalId: string })
      .approvalId;
  const mailTurn = { toolCalls: [{ callId: "m1", name: "send_mail", input: { to: "amara@kestrelpay.example" } }] };

  beforeAll(async () => {
    t = await createTestDatabase();
    const [{ id: kestrel }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
    await t.sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, enabled, synced_at)
                VALUES (${LEO}, ${kestrel}, 'user', ${LEO}, 'leo.martin', 'leo.martin', true, now())`;
    leo = { tenantId: kestrel, userId: LEO };
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("drives a run one checkpoint per job, waits on its approval, and resumes once it's decided", async () => {
    const sent = new Map<string, number>();
    const handler = handlerFor(scriptedTurns([mailTurn, { text: "Sent." }]).model, [mailTool(sent)]);
    const runId = await start();
    expect(await drain(handler)).toBe(2);
    expect((await state(runId)).run.status).toBe("waiting");

    await decideApproval(t.appDb, leo, await approvalOf(runId), "approved", async (viewer, id) => {
      await withTenantOn(t.appDb, viewer.tenantId, (tx) => enqueueStep(tx, viewer, id));
    });
    expect(await drain(handler)).toBe(3);
    const s = await state(runId);
    expect(s.run.status).toBe("succeeded");
    expect([...sent.values()]).toEqual([1]);
    const [{ steps }] = await t.sql`
      SELECT count(*)::int AS steps FROM run_events WHERE run_id = ${runId} AND step_key LIKE 'job:%'`;
    expect(steps).toBeGreaterThan(0);
  });

  it("takes back a run a killed worker left mid-tool-call, and the write happens once", async () => {
    const sent = new Map<string, number>();
    const handler = handlerFor(scriptedTurns([mailTurn, { text: "Sent." }]).model, [mailTool(sent, true)]);
    const runId = await start();
    await drain(handler);
    await decideApproval(t.appDb, leo, await approvalOf(runId), "approved", async (viewer, id) => {
      await withTenantOn(t.appDb, viewer.tenantId, (tx) => enqueueStep(tx, viewer, id));
    });

    // A worker claims the step and dies mid-send: no heartbeat, its process gone (the abort).
    const job = (await claim<AgentJob>(t.db, AGENT_QUEUE, "killed", 150))!;
    const killed = new AbortController();
    const dying = handler(job, killed.signal).catch(() => "died");
    await expect.poll(() => sent.size).toBe(1);
    killed.abort(new Error("SIGKILL"));
    expect(await dying).toBe("died");
    expect((await state(runId)).run.status).toBe("running");

    await sleep(200);
    expect(await reclaimExpired(t.db, AGENT_QUEUE)).toEqual({ requeued: 1, dead: 0 });
    await drain(handler);
    const s = await state(runId);
    expect(s.run.status).toBe("succeeded");
    // Two attempts, one key: the other side sent it once.
    expect([...sent.values()]).toEqual([2]);
    expect(s.events.filter((e) => e.data.type === "tool_result")).toHaveLength(1);
  });

  it("expires an approval nobody decided, and the run carries on without the write", async () => {
    const sent = new Map<string, number>();
    const handler = handlerFor(scriptedTurns([mailTurn, { text: "It expired." }]).model, [mailTool(sent)], 100);
    const runId = await start();
    await drain(handler);
    expect((await state(runId)).run.status).toBe("waiting");
    await sleep(150);
    await drain(handler);
    const s = await state(runId);
    expect(s.run.status).toBe("succeeded");
    expect(sent.size).toBe(0);
    expect(s.events.map((e) => e.data)).toContainEqual(
      expect.objectContaining({ type: "approval_decided", decision: "expired", by: null }),
    );
  });

  it("fails the run when a checkpoint fails for good", async () => {
    const handler = handlerFor(scriptedTurns([]).model, []);
    const runId = await start();
    await drain(handler);
    const s = await state(runId);
    expect(s.run.status).toBe("failed");
    expect(s.events.at(-2)!.data).toMatchObject({ type: "error", retryable: false });
  });
});
