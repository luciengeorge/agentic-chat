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

describe.skipIf(!postgresAvailable)("a write inside a Workflow step", () => {
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

  it("sends Grace's mail once when the step dies after the send and Workflow runs it again", async () => {
    const mailroom = new Mailroom();
    const runtime = graceRuntime(t.appDb, { mailroom });
    // The send goes out, then the step dies before Workflow hears it finished: the server was killed.
    let died = false;
    const base = runtime.loop;
    runtime.loop = (viewer) => {
      const loop = base(viewer);
      return {
        ...loop,
        async runTools(calls, ctx) {
          const results = await loop.runTools(calls, ctx);
          if (!died && calls.some((call) => call.tool === "send_mail")) {
            died = true;
            throw new Error("the server died before the step finished");
          }
          return results;
        },
      };
    };
    setAgentRuntime(runtime);

    const runId = crypto.randomUUID();
    await startRun(t.appDb, grace, { runId, message: { messageId: "m1", text: GRACE_MESSAGE } });
    const run = await start(agentRunWorkflow, [grace.tenantId, grace.userId, runId]);
    const state = async () => (await withTenantOn(t.appDb, grace.tenantId, (tx) => loadState(tx, grace, runId)))!;
    await expect.poll(async () => (await state()).run.status, { timeout: 20_000 }).toBe("waiting");
    const { approvalId } = (await state()).events.flatMap((e) =>
      e.data.type === "approval_requested" ? [e.data] : [],
    )[0]!;
    expect(await decideApproval(t.appDb, grace, approvalId, "approved", workflowWaker(t.appDb))).toBe("ok");
    expect(await run.returnValue).toEqual({ status: "succeeded" });

    const steps = (
      await (
        await getWorld()
      ).steps.list({ runId: run.runId, resolveData: "none", pagination: { limit: 100 } } as never)
    ).data as {
      stepId: string;
      stepName: string;
      attempt: number;
    }[];
    const retried = steps.filter((step) => step.stepName.endsWith("toolStep") && step.attempt === 2);
    expect(retried, "the send's tool step ran twice, as one step: attempt 2").toHaveLength(1);
    const key = `agent:${runId}:${retried[0].stepId}`;
    expect(
      mailroom.attempts,
      "both attempts of the step must send the step's key, `agent:<run>:<stepId>`: inside Workflow the tools get " +
        "it through `withIdempotencyKey`, in place of the loop's `agent:<run>:<callId>`",
    ).toEqual([key, key]);
    expect(mailroom.mails, "fake-workspace keeps one mail per key: Tom gets one").toEqual([key]);
    const sendResults = (await state()).events.filter(
      (e) => e.data.type === "tool_result" && e.data.callId === SEND_CALL,
    );
    expect(sendResults, "and the log holds the send's result once").toHaveLength(1);
  }, 60_000);
});
