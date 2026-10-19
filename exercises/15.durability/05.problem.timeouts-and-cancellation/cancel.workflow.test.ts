import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { getWorld } from "workflow/runtime";

import type { Viewer } from "#learn/retrieve/types";

import { durableWorld, GRACE_MESSAGE, graceRuntime, hangingModel, Mailroom } from "@/core/agent/durable-testing";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { cancelRun, loadState, startRun } from "@/lib/agent-runs";
import { setAgentRuntime } from "@/lib/agent-runtime";
import { agentRunWorkflow } from "@/workflows/agent-run";
import { workflowWaker } from "@/workflows/agent-run-start";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!postgresAvailable)("timeouts and cancellation", () => {
  let t: TestDatabase;
  let grace: Viewer;

  const begin = async (options: Partial<Parameters<typeof graceRuntime>[1]>) => {
    setAgentRuntime(graceRuntime(t.appDb, { mailroom: new Mailroom(), ...options }));
    const runId = crypto.randomUUID();
    await startRun(t.appDb, grace, { runId, message: { messageId: "m1", text: GRACE_MESSAGE } });
    const run = await start(agentRunWorkflow, [grace.tenantId, grace.userId, runId]);
    const state = async () => (await withTenantOn(t.appDb, grace.tenantId, (tx) => loadState(tx, grace, runId)))!;
    const ended = (why: string) =>
      Promise.race([run.returnValue, sleep(15_000).then(() => ({ status: `not finished after 15 s: ${why}` }))]);
    return { runId, run, state, ended };
  };
  const modelSteps = async (workflowRunId: string) =>
    (
      (await (
        await getWorld()
      ).steps.list({
        runId: workflowRunId,
        resolveData: "none",
        pagination: { limit: 100 },
      } as never)) as { data: { stepName: string; attempt: number; status: string }[] }
    ).data.filter((step) => step.stepName.endsWith("modelTurnStep"));

  beforeAll(async () => {
    t = await createTestDatabase();
    ({ grace } = await durableWorld(t.sql));
  }, 60_000);

  afterAll(async () => {
    setAgentRuntime(null);
    await t?.drop();
  });

  it("aborts the live model call when Grace cancels mid-turn, and the run ends cancelled with no half turn", async () => {
    // Her third model turn (the one that reads the contract's results) hangs, as a streaming call would.
    const hang = hangingModel(2);
    const { runId, run, state, ended } = await begin({ model: hang.model });
    await expect.poll(() => hang.calls(), { timeout: 20_000 }).toBe(3);
    const before = (await state()).events.length;
    expect(await cancelRun(t.appDb, grace, runId, workflowWaker(t.appDb))).toBe("ok");
    expect(await ended("the cancel reached the run's hook: race the turn against it")).toEqual({
      status: "cancelled",
    });
    expect(hang.aborted(), "the model call in flight was aborted through the run's controller").toBe(true);
    const s = await state();
    expect(s.run.status).toBe("cancelled");
    expect(
      s.events.map((e) => e.data.type).slice(before),
      "after the cancel, the log holds only the move to cancelled: no turn from the aborted call",
    ).toEqual(["status"]);
    expect([before, s.events.length, s.run.version]).toEqual([7, 8, 7]);
    expect(s.events.at(-1)!.data).toMatchObject({ from: "running", to: "cancelled", reason: "cancelled by the user" });
    expect((await modelSteps(run.runId)).length).toBe(3);
  }, 60_000);

  it("gives up on a hung model call at the step's timeout, and Workflow's second attempt goes through", async () => {
    // The first call hangs; the step's timer is 300 ms here (120 s in the app); the retry waits 1 ms (data).
    const hang = hangingModel(0);
    const { runId, run, state } = await begin({ model: hang.model, stepTimeoutMs: 300 });
    await expect.poll(async () => (await state()).run.status, { timeout: 20_000 }).toBe("waiting");
    expect(hang.aborted(), "the step's timeout aborted the hung call").toBe(true);
    const first = (await modelSteps(run.runId)).find((step) => step.attempt > 1);
    expect(first, "the timed-out turn was retried by Workflow: a timeout is a RetryableError").toMatchObject({
      attempt: 2,
      status: "completed",
    });
    const turns = (await state()).events.filter((e) => e.data.type === "assistant_turn");
    expect(turns, "four turns to the approval, each once: the timed-out attempt wrote nothing").toHaveLength(4);
    await cancelRun(t.appDb, grace, runId, workflowWaker(t.appDb));
    await run.returnValue;
  }, 60_000);
});
