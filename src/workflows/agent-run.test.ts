import { waitForHook, waitForSleep } from "@workflow/vitest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getRun, resumeHook, start } from "workflow/api";
import { z } from "zod";

import type { AgentTool } from "#learn/agent/types";
import type { ChatModel } from "#learn/model/types";
import type { Viewer } from "#learn/retrieve/types";

import { scriptedTurns } from "#learn/model/testing";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { cancelRun, createRunnerLoop, decideApproval, loadState, startRun } from "@/lib/agent-runs";
import { type AgentRuntime, setAgentRuntime } from "@/lib/agent-runtime";

import type { TokenChunk } from "./agent-run-steps";

import { agentRunWorkflow, approvalToken, runToken } from "./agent-run";

const LEO = "44444444-4444-4444-8444-444444444444";

/** send_mail that counts sends per idempotency key, as fake-workspace does. */
function mailTool(sent: Map<string, number>): AgentTool {
  return {
    name: "send_mail",
    description: "send mail",
    input: z.object({ to: z.string() }),
    effect: "write",
    needsApproval: () => true,
    execute: async (_, ctx) => {
      sent.set(ctx.idempotencyKey, (sent.get(ctx.idempotencyKey) ?? 0) + 1);
      return { sent: true };
    },
  };
}

const search: AgentTool = {
  name: "search_documents",
  description: "search",
  input: z.object({ query: z.string() }),
  effect: "read",
  needsApproval: () => false,
  execute: async (input) => ({ hits: [input] }),
};

describe.skipIf(!postgresAvailable)("the agent run as a Workflow", () => {
  let t: TestDatabase;
  let leo: Viewer;
  let sent: Map<string, number>;

  const runtime = (model: ChatModel, overrides: Partial<AgentRuntime> = {}): AgentRuntime => ({
    db: t.appDb,
    retryAfterMs: 1,
    loop: (viewer) => ({
      ...createRunnerLoop(viewer, { model, tools: [search, mailTool(sent)], reasoningEffort: "medium" }),
      compact: async () => null,
    }),
    ...overrides,
  });
  const state = async (runId: string) =>
    (await withTenantOn(t.appDb, leo.tenantId, (tx) => loadState(tx, leo, runId)))!;
  const types = async (runId: string) => (await state(runId)).events.map((e) => e.data.type);
  const begin = async (text = "mail amara the policy") => {
    const runId = crypto.randomUUID();
    await startRun(t.appDb, leo, { runId, message: { messageId: "m1", text } });
    const run = await start(agentRunWorkflow, [leo.tenantId, leo.userId, runId]);
    return { runId, run };
  };
  const approvalOf = async (runId: string) => {
    await expect.poll(async () => (await state(runId)).run.status, { timeout: 20_000 }).toBe("waiting");
    return (
      (await state(runId)).events.find((e) => e.data.type === "approval_requested")!.data as { approvalId: string }
    ).approvalId;
  };
  const mailTurn = { toolCalls: [{ callId: "m1", name: "send_mail", input: { to: "amara@kestrelpay.example" } }] };

  beforeAll(async () => {
    t = await createTestDatabase();
    const [{ id: kestrel }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
    await t.sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, enabled, synced_at)
                VALUES (${LEO}, ${kestrel}, 'user', ${LEO}, 'leo.martin', 'leo.martin', true, now())`;
    leo = { tenantId: kestrel, userId: LEO };
  }, 60_000);

  afterAll(async () => {
    setAgentRuntime(null);
    await t?.drop();
  });

  beforeEach(() => {
    sent = new Map();
  });

  it("reads, waits on the approval hook, resumes, sends once with the step's key, and replays without duplicates", async () => {
    setAgentRuntime(
      runtime(
        scriptedTurns([
          { toolCalls: [{ callId: "s1", name: "search_documents", input: { query: "policy" } }] },
          mailTurn,
          { text: "Sent it." },
        ]).model,
      ),
    );
    const { runId, run } = await begin();
    const approvalId = await approvalOf(runId);
    await waitForHook(run, { token: approvalToken(approvalId) });
    expect(await decideApproval(t.appDb, leo, approvalId, "approved")).toBe("ok");
    await resumeHook(approvalToken(approvalId), {});

    expect(await run.returnValue).toEqual({ status: "succeeded" });
    // Every wake-up replayed the workflow from the top; Postgres still has each event once.
    expect(await types(runId)).toEqual([
      "user_message",
      "status",
      "assistant_turn",
      "tool_result",
      "assistant_turn",
      "approval_requested",
      "status",
      "approval_decided",
      "status",
      "tool_result",
      "assistant_turn",
      "status",
    ]);
    const keys = await t.sql`SELECT step_key FROM run_events WHERE run_id = ${runId} AND step_key IS NOT NULL`;
    expect(keys.length).toBeGreaterThanOrEqual(5);
    expect(keys.every((row) => /^wf:step_/.test(row.step_key))).toBe(true);
    expect([...sent.entries()]).toEqual([[expect.stringMatching(new RegExp(`^agent:${runId}:step_`)), 1]]);
    expect((await state(runId)).run.workflowRunId).toBe(run.runId);
    // The model's text went to the run's stream as it came, keyed by its turn's step.
    const tokens: TokenChunk[] = [];
    for await (const chunk of run.getReadable<TokenChunk>()) tokens.push(chunk);
    expect(tokens.map((t) => t.delta).join("")).toBe("Sent it.");
    expect(tokens[0].turn).toMatch(/^wf:step_/);
  }, 30_000);

  it("expires an approval after its 7 days (the sleep woken), and the run carries on without sending", async () => {
    setAgentRuntime(runtime(scriptedTurns([mailTurn, { text: "It expired." }]).model));
    const { runId, run } = await begin();
    const approvalId = await approvalOf(runId);
    const sleepId = await waitForSleep(run);
    await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });
    expect(await run.returnValue).toEqual({ status: "succeeded" });
    expect(sent.size).toBe(0);
    const decided = (await state(runId)).events.find((e) => e.data.type === "approval_decided")!.data;
    expect(decided).toEqual({ type: "approval_decided", approvalId, decision: "expired", by: null });
  }, 30_000);

  it("cancels mid-turn: the model call in flight is aborted and the run ends cancelled", async () => {
    let aborted = false;
    let started = false;
    const hanging: ChatModel = {
      id: "hanging",
      async *stream(request) {
        started = true;
        await new Promise((_, reject) =>
          request.abortSignal!.addEventListener("abort", () => {
            aborted = true;
            reject(request.abortSignal!.reason);
          }),
        );
        yield* [];
      },
    };
    setAgentRuntime(runtime(hanging));
    const { runId, run } = await begin();
    await expect.poll(() => started, { timeout: 20_000 }).toBe(true);
    expect(await cancelRun(t.appDb, leo, runId)).toBe("ok");
    await resumeHook(runToken(runId), { kind: "cancel" });
    expect(await run.returnValue).toEqual({ status: "cancelled" });
    expect(aborted).toBe(true);
    expect((await state(runId)).run.status).toBe("cancelled");
  }, 30_000);

  it("retries a model turn that hit a 503, with retryAfter passed in as data, then succeeds", async () => {
    const { model } = scriptedTurns([{ text: "Done." }]);
    let calls = 0;
    const flaky: ChatModel = {
      id: "flaky",
      stream(request) {
        if (calls++ === 0) throw Object.assign(new Error("Service Unavailable"), { statusCode: 503 });
        return model.stream(request);
      },
    };
    setAgentRuntime(runtime(flaky));
    const { runId, run } = await begin("hello");
    expect(await run.returnValue).toEqual({ status: "succeeded" });
    expect(calls).toBe(2);
    expect(await types(runId)).toEqual(["user_message", "status", "assistant_turn", "status"]);
  }, 30_000);

  it("fails the run on an error retrying can't fix", async () => {
    setAgentRuntime(runtime(scriptedTurns([]).model));
    const { runId, run } = await begin("hello");
    expect(await run.returnValue).toEqual({ status: "failed" });
    const s = await state(runId);
    expect(s.run.status).toBe("failed");
    expect(s.events.at(-2)!.data).toMatchObject({ type: "error", retryable: false });
  }, 30_000);

  it("answers a second start of the same run as a duplicate", async () => {
    setAgentRuntime(runtime(scriptedTurns([mailTurn]).model));
    const { runId, run } = await begin();
    await approvalOf(runId);
    const second = await start(agentRunWorkflow, [leo.tenantId, leo.userId, runId]);
    expect(await second.returnValue).toEqual({ status: "duplicate" });
    await cancelRun(t.appDb, leo, runId);
    await resumeHook(runToken(runId), { kind: "cancel" });
    expect(await run.returnValue).toEqual({ status: "cancelled" });
  }, 30_000);
});
