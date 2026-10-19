// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Viewer } from "#learn/retrieve/types";

import { createWorkspaceWriter } from "#learn/agent/tools/workspace";
import { durableWorld, heldWorkspace, KESTREL_WORKSPACE_TOKEN, WORKSPACE_URL } from "@/core/agent/durable-testing";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { runStore } from "@/lib/agent-runs";

import { approveHeld, type DurabilityDeps, heldRun, LAB_MARK, listHeldRuns, startHeldRun } from "./durability-server";

describe.skipIf(!postgresAvailable)("the durability lab's server", () => {
  let t: TestDatabase;
  let grace: Viewer;
  const workspace = heldWorkspace();
  const kicked: string[] = [];
  const woken: string[] = [];
  const deps = (): DurabilityDeps => ({
    db: t.appDb,
    kick: (_, runId) => void kicked.push(runId),
    wake: async (_, runId, wake) => void woken.push(`${runId}:${wake.kind}`),
    workspace: { baseUrl: WORKSPACE_URL, site: "kestrel", token: KESTREL_WORKSPACE_TOKEN, fetch: workspace.fetch },
  });

  beforeAll(async () => {
    t = await createTestDatabase();
    ({ grace } = await durableWorld(t.sql));
  });

  afterAll(async () => {
    await workspace.close();
    await t?.drop();
  });

  it("starts a marked run, kicks its runner, lists it, and shows it", async () => {
    const { runId } = await startHeldRun(deps(), grace, "grace.adeyemi@kestrelpay.example");
    expect(kicked).toContain(runId);
    expect((await listHeldRuns(t.appDb, grace)).map((r) => r.id)).toEqual([runId]);
    const view = await heldRun(deps(), grace, runId);
    expect(view).toMatchObject({ status: "queued", approval: null, approvedAt: null, mails: [] });
    expect(view!.events[0].summary.startsWith(LAB_MARK)).toBe(true);
    expect(await heldRun(deps(), { ...grace, userId: crypto.randomUUID() }, runId), "another user's run").toBeNull();
  });

  it("approves a waiting send only after holding the next one in fake-workspace, and wakes the runner", async () => {
    const { runId } = await startHeldRun(deps(), grace, "grace.adeyemi@kestrelpay.example");
    expect(await approveHeld(deps(), grace, runId), "nothing waits yet").toBe("not-pending");
    const store = runStore(t.appDb, grace, runId);
    await store.append(1, [{ type: "status", from: "queued", to: "running" }]);
    await store.requestApproval({ callId: "c1", tool: "send_mail", input: {} }, 2, { stepKey: "lab" });
    expect((await heldRun(deps(), grace, runId))!.approval).toMatchObject({ tool: "send_mail" });
    expect(await approveHeld(deps(), grace, runId)).toBe("ok");
    expect(woken).toContain(`${runId}:approval`);
    const view = (await heldRun(deps(), grace, runId))!;
    expect(view.approval).toBeNull();
    expect(view.approvedAt).not.toBeNull();
    // The fault holds the viewer's next send for 20 s; once it's let go, the mail shows under the run's key.
    const writer = createWorkspaceWriter({
      baseUrl: WORKSPACE_URL,
      site: "kestrel",
      token: KESTREL_WORKSPACE_TOKEN,
      fetch: workspace.fetch,
    });
    const mail = { to: ["tom.whitfield@kestrelpay.example"], subject: "lab", body: "held", attachments: [] };
    const sending = writer.sendMail(grace.userId, mail, `agent:${runId}:step_1`, new AbortController().signal);
    await expect.poll(() => workspace.waits()).toEqual([20]);
    await workspace.release();
    await sending;
    expect((await heldRun(deps(), grace, runId))!.mails.map((m) => m.idempotencyKey)).toEqual([
      `agent:${runId}:step_1`,
    ]);
  });
});
