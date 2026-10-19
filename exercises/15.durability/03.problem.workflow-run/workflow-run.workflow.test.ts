import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { getWorld } from "workflow/runtime";

import type { Viewer } from "#learn/retrieve/types";

import { durableWorld, GRACE_MESSAGE, graceRuntime, Mailroom } from "@/core/agent/durable-testing";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { decideApproval, loadState, startRun } from "@/lib/agent-runs";
import { setAgentRuntime } from "@/lib/agent-runtime";
import { agentRunWorkflow } from "@/workflows/agent-run";
import { workflowWaker } from "@/workflows/agent-run-start";

const SEND_CALL = "call_4NmkEZ5nioB2ceFw1vL09fLI";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!postgresAvailable)("Grace's run as a Workflow", () => {
  let t: TestDatabase;
  let grace: Viewer;

  beforeAll(async () => {
    t = await createTestDatabase();
    ({ grace } = await durableWorld(t.sql));
  }, 60_000);

  afterAll(async () => {
    setAgentRuntime(null);
    await t?.drop();
  });

  it("runs to the end once approved: 17 events at version 15 in Postgres, each written once, and one mail", async () => {
    const mailroom = new Mailroom();
    setAgentRuntime(graceRuntime(t.appDb, { mailroom }));
    const runId = crypto.randomUUID();
    await startRun(t.appDb, grace, { runId, message: { messageId: "m1", text: GRACE_MESSAGE } });
    const run = await start(agentRunWorkflow, [grace.tenantId, grace.userId, runId]);
    const state = async () => (await withTenantOn(t.appDb, grace.tenantId, (tx) => loadState(tx, grace, runId)))!;
    await expect.poll(async () => (await state()).run.status, { timeout: 20_000 }).toBe("waiting");

    // A second start of the same run, as two kicks at once would make: `bindRun` lets one workflow drive it.
    const second = await start(agentRunWorkflow, [grace.tenantId, grace.userId, runId]);
    expect(await second.returnValue).toEqual({ status: "duplicate" });

    const { approvalId } = (await state()).events.flatMap((e) =>
      e.data.type === "approval_requested" ? [e.data] : [],
    )[0]!;
    // The app's own waker: it asks `kickAction` what to do with the run's workflow, then wakes it.
    expect(await decideApproval(t.appDb, grace, approvalId, "approved", workflowWaker(t.appDb))).toBe("ok");
    const ended = await Promise.race([
      run.returnValue,
      sleep(20_000).then(() => ({ status: "still waiting 20 s after the approval: did the kick wake the workflow?" })),
    ]);
    expect(ended).toEqual({ status: "succeeded" });

    const s = await state();
    expect(
      s.events.map((e) => (e.data.type === "status" ? `${e.data.from}->${e.data.to}` : e.data.type)),
      "Workflow replayed the body from the top after every step and after the approval; Postgres has each event once",
    ).toEqual([
      "user_message",
      "queued->running",
      "assistant_turn",
      "tool_result",
      "assistant_turn",
      "tool_result",
      "tool_result",
      "assistant_turn",
      "tool_result",
      "assistant_turn",
      "approval_requested",
      "running->waiting",
      "approval_decided",
      "waiting->running",
      "tool_result",
      "assistant_turn",
      "running->succeeded",
    ]);
    expect(s.run.version).toBe(15);
    const keys = await t.sql<{ step_key: string }[]>`
      SELECT step_key FROM run_events WHERE run_id = ${runId} AND step_key IS NOT NULL`;
    expect(keys.length, "every event a step wrote carries its step's key").toBe(12);
    expect(keys.every((k) => /^wf:step_\w+:\d+$/.test(k.step_key))).toBe(true);
    expect(s.run.workflowRunId, "the run names the workflow that drove it").toBe(run.runId);

    expect(
      mailroom.mails,
      "one mail, under the send step's key: a second workflow on the run would have sent its own",
    ).toEqual([expect.stringMatching(new RegExp(`^agent:${runId}:step_`))]);
    expect(s.events.filter((e) => e.data.type === "tool_result" && e.data.callId === SEND_CALL)).toHaveLength(1);

    const world = await getWorld();
    const steps = (
      await world.steps.list({ runId: run.runId, resolveData: "none", pagination: { limit: 100 } } as never)
    ).data as { stepName: string }[];
    const names = steps.map((step) => step.stepName.split("//").at(-1));
    expect(
      names.filter((n) => n === "modelTurnStep"),
      "five model turns, one step each",
    ).toHaveLength(5);
    expect(
      names.filter((n) => n === "toolStep"),
      "five tool calls, one step each",
    ).toHaveLength(5);
    expect(
      names.filter((n) => n === "recordStep"),
      "four turns' results, one record step each",
    ).toHaveLength(4);
  }, 60_000);
});
