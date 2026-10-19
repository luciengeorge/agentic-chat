import { waitForHook, waitForSleep } from "@workflow/vitest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRun, resumeHook, start } from "workflow/api";
import { getWorld } from "workflow/runtime";

import type { Viewer } from "#learn/retrieve/types";

import { approvalToken } from "#learn/agent/durable-run";
import { durableWorld, GRACE_MESSAGE, graceRuntime, Mailroom } from "@/core/agent/durable-testing";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { decideApproval, loadState, startRun } from "@/lib/agent-runs";
import { setAgentRuntime } from "@/lib/agent-runtime";
import { agentRunWorkflow } from "@/workflows/agent-run";

const DAY_MS = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!postgresAvailable)("approvals that wait days", () => {
  let t: TestDatabase;
  let grace: Viewer;

  const begin = async (mailroom: Mailroom) => {
    setAgentRuntime(graceRuntime(t.appDb, { mailroom }));
    const runId = crypto.randomUUID();
    await startRun(t.appDb, grace, { runId, message: { messageId: "m1", text: GRACE_MESSAGE } });
    const run = await start(agentRunWorkflow, [grace.tenantId, grace.userId, runId]);
    const state = async () => (await withTenantOn(t.appDb, grace.tenantId, (tx) => loadState(tx, grace, runId)))!;
    await expect.poll(async () => (await state()).run.status, { timeout: 20_000 }).toBe("waiting");
    const requested = (await state()).events.filter((e) => e.data.type === "approval_requested").at(-1)!;
    const { approvalId, expiresAt } = requested.data as { approvalId: string; expiresAt: string };
    return { runId, run, state, approvalId, expiresAt, requestedAt: requested.at };
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    ({ grace } = await durableWorld(t.sql));
  }, 60_000);

  afterAll(async () => {
    setAgentRuntime(null);
    await t?.drop();
  });

  it("decides nothing on a forged resume: the run reads Postgres, waits again, and sends only once Grace approves", async () => {
    const mailroom = new Mailroom();
    const { run, state, approvalId } = await begin(mailroom);
    await waitForHook(run, { token: approvalToken(approvalId) });

    // Anyone who can reach a resume route can send this. Nobody decided anything.
    await resumeHook(approvalToken(approvalId), { decision: "approved" });
    await sleep(1_500);
    expect((await state()).run.status, "a hook's payload isn't a decision: the plan found none, so it waits").toBe(
      "waiting",
    );
    expect(mailroom.attempts, "nothing is sent on a forged resume").toEqual([]);

    // The real decision: the row and the log first, then the hook.
    expect(await decideApproval(t.appDb, grace, approvalId, "approved")).toBe("ok");
    await waitForHook(run, { token: approvalToken(approvalId) });
    await resumeHook(approvalToken(approvalId), {});
    expect(await run.returnValue).toEqual({ status: "succeeded" });
    expect(mailroom.mails).toHaveLength(1);
  }, 60_000);

  it("expires Grace's approval after its 7 days, woken early, and the run carries on without the mail", async () => {
    const mailroom = new Mailroom();
    const { run, state, approvalId, expiresAt, requestedAt } = await begin(mailroom);
    expect(Date.parse(expiresAt) - Date.parse(requestedAt)).toBeGreaterThan(7 * DAY_MS - 5_000);

    const sleepId = await waitForSleep(run);
    const events = (await (
      await getWorld()
    ).events.list({
      runId: run.runId,
      pagination: { limit: 200 },
      resolveData: "all",
    } as never)) as { data: { eventType: string; correlationId?: string; eventData?: { resumeAt?: string | Date } }[] };
    const wait = events.data.find((e) => e.eventType === "wait_created" && e.correlationId === sleepId);
    expect(
      new Date(wait!.eventData!.resumeAt!).toISOString(),
      "the workflow sleeps until the approval's own expiresAt, the time Postgres has",
    ).toBe(expiresAt);

    // A week, in a test: end the sleep now.
    await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });
    const ended = await Promise.race([
      run.returnValue,
      sleep(15_000).then(() => ({
        status: "not finished 15 s after the sleep ended: when the sleep wins, settle the approval (`steps.expire`)",
      })),
    ]);
    expect(ended).toEqual({ status: "succeeded" });
    expect(mailroom.attempts, "an expired approval sends nothing").toEqual([]);
    const decided = (await state()).events.find((e) => e.data.type === "approval_decided")!.data;
    expect(decided, "the expiry is written to the log like a decision, by nobody").toEqual({
      type: "approval_decided",
      approvalId,
      decision: "expired",
      by: null,
    });
  }, 60_000);
});
