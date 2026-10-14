import { waitForHook } from "@workflow/vitest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRun, start } from "workflow/api";
import { z } from "zod";

import type { AgentTool } from "#learn/agent/types";
import type { ScriptedTurn } from "#learn/model/testing";
import type { ChatModel } from "#learn/model/types";
import type { Viewer } from "#learn/retrieve/types";

import { childRunId, delegateTool } from "#learn/agent/orchestrate";
import { scriptedTurns } from "#learn/model/testing";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { cancelRun, createRunnerLoop, loadState, startRun } from "@/lib/agent-runs";
import { type AgentRuntime, setAgentRuntime } from "@/lib/agent-runtime";

import { agentRunWorkflow, runToken } from "./agent-run";
import { reconcileCancelledRuns, workflowWaker } from "./agent-run-start";

const LEO = "44444444-4444-4444-8444-444444444444";

const readDoc: AgentTool = {
  name: "read_document",
  description: "read",
  input: z.object({ documentId: z.string() }),
  effect: "read",
  needsApproval: () => false,
  execute: async (input) => ({ text: `the text of ${(input as { documentId: string }).documentId}` }),
};

const mail: AgentTool = {
  name: "send_mail",
  description: "mail",
  input: z.object({ to: z.string() }),
  effect: "write",
  needsApproval: () => true,
  execute: async () => ({ sent: true }),
};

/** One script per run, picked by the run's first message: the parent and each child have their own. */
function byTask(scripts: Record<string, ScriptedTurn[]>): ChatModel {
  const models = Object.entries(scripts).map(([key, turns]) => [key, scriptedTurns(turns).model] as const);
  return {
    id: "by-task",
    stream(request) {
      const first = request.messages.find((m) => m.role === "user");
      const text = typeof first?.content === "string" ? first.content : "";
      const match = models.find(([key]) => text.includes(key));
      if (!match) throw new Error(`no script for ${JSON.stringify(text)}`);
      return match[1].stream(request);
    },
  };
}

const delegate = (callId: string, task: string) => ({ callId, name: "delegate", input: { task } });

describe.skipIf(!postgresAvailable)("the orchestrator as child workflows", () => {
  let t: TestDatabase;
  let leo: Viewer;

  const runtime = (model: ChatModel): AgentRuntime => ({
    db: t.appDb,
    retryAfterMs: 1,
    loop: (viewer) => ({
      ...createRunnerLoop(viewer, { model, tools: [readDoc, mail, delegateTool()], reasoningEffort: "medium" }),
      compact: async () => null,
    }),
  });
  const state = async (runId: string) =>
    (await withTenantOn(t.appDb, leo.tenantId, (tx) => loadState(tx, leo, runId)))!;
  const begin = async (text: string) => {
    const runId = crypto.randomUUID();
    await startRun(t.appDb, leo, { runId, message: { messageId: "m1", text } });
    const run = await start(agentRunWorkflow, [leo.tenantId, leo.userId, runId]);
    return { runId, run };
  };

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

  it("runs each delegate call as a child run and gives the parent only their answers; a failed child fails its call", async () => {
    setAgentRuntime(
      runtime(
        byTask({
          Compare: [
            { toolCalls: [delegate("c1", "Report the hotel rules of policy v1"), delegate("c2", "Report v2's")] },
            { text: "v2 raises the hotel cap." },
          ],
          "policy v1": [
            { toolCalls: [{ callId: "r1", name: "read_document", input: { documentId: "v1" } }] },
            { text: "v1: hotels up to 150 a night." },
          ],
          // A child whose model fails for good: the run fails.
          "v2's": [],
        }),
      ),
    );
    const { runId, run } = await begin("Compare what policy v1 and v2 say about hotels");
    expect(await run.returnValue).toEqual({ status: "succeeded" });

    const parent = await state(runId);
    const results = parent.events.flatMap((e) => (e.data.type === "tool_result" ? [e.data] : []));
    expect(results).toEqual([
      {
        type: "tool_result",
        callId: "c1",
        ok: true,
        output: { runId: childRunId(runId, "c1"), summary: "v1: hotels up to 150 a night." },
        // What the child spent, so the parent's caps count it.
        usage: { tokens: 120, toolCalls: 1 },
      },
      {
        type: "tool_result",
        callId: "c2",
        ok: false,
        error: expect.stringMatching(/^The sub-agent failed: /),
        usage: { tokens: 0, toolCalls: 0 },
      },
    ]);
    // Only the parent's own calls are in its log.
    expect(results.map((r) => r.callId)).not.toContain("r1");

    const children = await t.sql`
      SELECT id, kind, parent_run_id, user_id, status, caps FROM runs WHERE parent_run_id = ${runId} ORDER BY id`;
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child).toMatchObject({ kind: "subagent", parent_run_id: runId, user_id: LEO });
      // Half of what the parent has left: 60,000 less its first turn (110), and 30 calls less the two delegates.
      expect(child.caps).toMatchObject({ tokens: 29_945, toolCalls: 14 });
    }
    const v1 = await state(childRunId(runId, "c1"));
    expect(v1.run.status).toBe("succeeded");
    expect(v1.events.some((e) => e.data.type === "tool_result" && e.data.callId === "r1")).toBe(true);
  }, 60_000);

  it("refuses to let a sub-agent delegate in turn", async () => {
    setAgentRuntime(
      runtime(
        byTask({
          Plan: [{ toolCalls: [delegate("c1", "Nest deeper")] }, { text: "done" }],
          "Nest deeper": [{ toolCalls: [delegate("d1", "deeper still")] }, { text: "I couldn't hand it on." }],
        }),
      ),
    );
    const { runId, run } = await begin("Plan a thing");
    expect(await run.returnValue).toEqual({ status: "succeeded" });
    const child = await state(childRunId(runId, "c1"));
    expect(child.events.find((e) => e.data.type === "tool_result")!.data).toMatchObject({
      ok: false,
      error: expect.stringContaining("sub-agent is read-only"),
    });
    expect(await t.sql`SELECT 1 FROM runs WHERE parent_run_id = ${childRunId(runId, "c1")}`).toHaveLength(0);
  }, 60_000);

  it("keeps a sub-agent read-only: a task asking for a mail gets it refused, with no approval and nothing sent", async () => {
    setAgentRuntime(
      runtime(
        byTask({
          Mail: [{ toolCalls: [delegate("c1", "Send the mail to amara")] }, { text: "The helper couldn't send it." }],
          "Send the mail": [
            { toolCalls: [{ callId: "m1", name: "send_mail", input: { to: "amara" } }] },
            { text: "I can't send mail." },
          ],
        }),
      ),
    );
    const { runId, run } = await begin("Mail amara via a helper");
    expect(await run.returnValue).toEqual({ status: "succeeded" });
    const child = childRunId(runId, "c1");
    const childState = await state(child);
    expect(childState.run.status).toBe("succeeded");
    expect(childState.events.find((e) => e.data.type === "tool_result")!.data).toMatchObject({
      callId: "m1",
      ok: false,
      error: expect.stringContaining("sub-agent is read-only"),
    });
    expect(await t.sql`SELECT 1 FROM approvals WHERE run_id = ${child}`).toEqual([]);
  }, 60_000);

  it("cancels the children with the parent, and the parent stops waiting", async () => {
    const scripted = byTask({ Research: [{ toolCalls: [delegate("c1", "Read everything slowly")] }] });
    const hanging: ChatModel = {
      id: "hanging-child",
      async *stream(request) {
        const first = request.messages.find((m) => m.role === "user");
        if (typeof first?.content === "string" && first.content.includes("Read everything slowly")) {
          await new Promise((_, reject) =>
            request.abortSignal?.addEventListener("abort", () => reject(request.abortSignal!.reason)),
          );
        }
        yield* scripted.stream(request);
      },
    };
    setAgentRuntime(runtime(hanging));
    const { runId, run } = await begin("Research it via a helper");
    const child = childRunId(runId, "c1");
    await expect
      .poll(async () => (await state(child).catch(() => null))?.run.status, { timeout: 20_000 })
      .toBe("running");
    expect(await cancelRun(t.appDb, leo, runId, workflowWaker(t.appDb))).toBe("ok");
    expect(await run.returnValue).toEqual({ status: "cancelled" });
    const childState = await state(child);
    expect(childState.run.status).toBe("cancelled");
    expect(childState.events.at(-1)!.data).toMatchObject({ to: "cancelled", reason: "its parent run was cancelled" });
  }, 60_000);

  it("reconciles a run whose workflow was cancelled outside the app", async () => {
    setAgentRuntime(
      runtime(byTask({ Outside: [{ toolCalls: [{ callId: "m1", name: "send_mail", input: { to: "x" } }] }] })),
    );
    const { runId, run } = await begin("Outside job");
    await expect.poll(async () => (await state(runId)).run.status, { timeout: 20_000 }).toBe("waiting");
    await waitForHook(run, { token: runToken(runId) });
    await getRun(run.runId).cancel({ cancelReason: "workflow cancel from the CLI" });
    expect((await state(runId)).run.status).toBe("waiting");

    expect(await reconcileCancelledRuns(t.db, t.appDb)).toEqual([runId]);
    const after = await state(runId);
    expect(after.run.status).toBe("cancelled");
    expect(after.events.at(-1)!.data).toMatchObject({ to: "cancelled", reason: "cancelled outside the app" });
    expect(await t.sql`SELECT status, decided_by FROM approvals WHERE run_id = ${runId}`).toEqual([
      { status: "rejected", decided_by: null },
    ]);
    expect(await reconcileCancelledRuns(t.db, t.appDb)).toEqual([]);
  }, 60_000);
});
