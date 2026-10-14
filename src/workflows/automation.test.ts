import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { z } from "zod";

import type { AgentTool } from "#learn/agent/types";
import type { ChatModel } from "#learn/model/types";
import type { Viewer } from "#learn/retrieve/types";

import { scriptedTurns } from "#learn/model/testing";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { cancelRun, createRunnerLoop, listApprovals } from "@/lib/agent-runs";
import { type AgentRuntime, setAgentRuntime } from "@/lib/agent-runtime";

import { workflowWaker } from "./agent-run-start";
import { automationWorkflow } from "./automation";
import { fireDriveChange } from "./automation-steps";

const LEO = "44444444-4444-4444-8444-444444444444";

const mail: AgentTool = {
  name: "send_mail",
  description: "mail",
  input: z.object({ to: z.string() }),
  effect: "write",
  needsApproval: () => true,
  execute: async () => ({ sent: true }),
};

/** Answers every run with one short turn, slowly enough that overlapping runs would show. */
function slowAnswers(log: { start: number; end: number }[]): ChatModel {
  return {
    id: "slow",
    async *stream(request) {
      const span = { start: Date.now(), end: 0 };
      await new Promise((resolve) => setTimeout(resolve, 150));
      span.end = Date.now();
      log.push(span);
      yield* scriptedTurns([{ text: "Summary." }]).model.stream(request);
    },
  };
}

describe.skipIf(!postgresAvailable)("automations as workflows", () => {
  let t: TestDatabase;
  let leo: Viewer;

  const runtime = (model: ChatModel, overrides: Partial<AgentRuntime> = {}): AgentRuntime => ({
    db: t.appDb,
    retryAfterMs: 1,
    loop: (viewer) => ({
      ...createRunnerLoop(viewer, { model, tools: [mail], reasoningEffort: "medium" }),
      compact: async () => null,
    }),
    ...overrides,
  });

  const automation = async (fields: {
    trigger: string;
    cron?: string | null;
    folder?: string | null;
    prompt?: string;
  }) => {
    const [row] = await t.sql`
      INSERT INTO automations (tenant_id, owner_id, name, prompt, trigger, cron, folder, created_at)
      VALUES (${leo.tenantId}, ${LEO}, 'test', ${fields.prompt ?? "Summarise"}, ${fields.trigger},
              ${fields.cron ?? null}, ${fields.folder ?? null}, now() - interval '1 hour')
      RETURNING id`;
    return row.id as string;
  };
  const document = async (path: string) => {
    const [row] = await t.sql`
      INSERT INTO documents (tenant_id, source, external_id, title, path, mime_type, version, source_version,
                             content_hash, status)
      VALUES (${leo.tenantId}, 'test', ${crypto.randomUUID()}, ${path.split("/").at(-1)!}, ${path}, 'text/plain', 1,
              '1', 'h', 'ready')
      RETURNING id, acl_version`;
    // The owner can read it: a fire covers only documents its owner can read.
    await t.sql`INSERT INTO document_acl (tenant_id, document_id, principal_id, effect, acl_version)
                VALUES (${leo.tenantId}, ${row.id}, ${LEO}, 'allow', ${row.acl_version})`;
    return row.id as string;
  };
  const runsOf = (automationId: string) =>
    t.sql`SELECT id, kind, user_id, status, conversation_id FROM runs WHERE automation_id = ${automationId}
          ORDER BY created_at`;

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

  it("fires a slot once whoever starts it, as an automation run acting as the owner", async () => {
    setAgentRuntime(runtime(scriptedTurns([{ text: "The policy says 150." }]).model));
    const id = await automation({ trigger: "schedule", cron: "0 9 * * *" });
    const args = [leo.tenantId, id, "schedule:2026-10-14T09:00:00.000Z", "2026-10-14T09:00:00.000Z", null] as const;
    const [a, b] = await Promise.all([start(automationWorkflow, [...args]), start(automationWorkflow, [...args])]);
    const outcomes = [await a.returnValue, await b.returnValue];
    expect(outcomes.map((o) => o.status).sort()).toEqual(["duplicate", "fired"]);
    expect(outcomes.find((o) => o.status === "fired")!.runs).toEqual([
      { kind: "done", value: { runId: expect.any(String), status: "succeeded" } },
    ]);
    expect(await runsOf(id)).toEqual([
      { id: expect.any(String), kind: "automation", user_id: LEO, status: "succeeded", conversation_id: null },
    ]);
    const [row] = await t.sql`SELECT last_fired_at, last_run_id FROM automations WHERE id = ${id}`;
    expect(new Date(row.last_fired_at).toISOString()).toBe("2026-10-14T09:00:00.000Z");
    expect(row.last_run_id).toBe((await runsOf(id))[0].id);
  }, 60_000);

  it("puts the run's approvals in the owner's inbox", async () => {
    setAgentRuntime(
      runtime(scriptedTurns([{ toolCalls: [{ callId: "m1", name: "send_mail", input: { to: "amara" } }] }]).model),
    );
    const id = await automation({ trigger: "schedule", cron: "0 * * * *", prompt: "Mail amara the digest" });
    const run = await start(automationWorkflow, [leo.tenantId, id, "schedule:x", new Date().toISOString(), null]);
    await expect
      .poll(async () => (await listApprovals(t.appDb, leo, "pending")).map((a) => a.tool), { timeout: 20_000 })
      .toEqual(["send_mail"]);
    const [{ id: runId }] = await runsOf(id);
    expect(await cancelRun(t.appDb, leo, runId, workflowWaker(t.appDb))).toBe("ok");
    expect((await run.returnValue).runs).toEqual([{ kind: "done", value: { runId, status: "cancelled" } }]);
  }, 60_000);

  it("fans a folder out one run per new document, never more than the limit at once", async () => {
    const spans: { start: number; end: number }[] = [];
    setAgentRuntime(runtime(slowAnswers(spans)));
    const id = await automation({ trigger: "schedule", cron: "0 9 * * *", folder: "/Digest" });
    for (const name of ["a", "b", "c", "d"]) await document(`/Digest/${name}.txt`);
    await document("/Elsewhere/e.txt");
    const run = await start(automationWorkflow, [leo.tenantId, id, "schedule:y", new Date().toISOString(), null, 2]);
    const { runs } = await run.returnValue;
    expect(runs).toHaveLength(4);
    expect(runs.every((r) => r.kind === "done" && r.value.status === "succeeded")).toBe(true);
    // Never three model calls at once.
    const overlap = (at: number) => spans.filter((s) => s.start <= at && at < s.end).length;
    expect(Math.max(...spans.map((s) => overlap(s.start)))).toBeLessThanOrEqual(2);
    expect(spans).toHaveLength(4);
  }, 60_000);

  it("stops starting runs once the kill switch is on; the rest are skipped", async () => {
    let admitted = 0;
    setAgentRuntime(
      runtime(scriptedTurns([{ text: "one" }, { text: "two" }]).model, {
        admit: async () => (admitted++ < 1 ? null : "kill switch: incident"),
      }),
    );
    const id = await automation({ trigger: "schedule", cron: "0 9 * * *", folder: "/Killed" });
    for (const name of ["a", "b", "c"]) await document(`/Killed/${name}.txt`);
    const run = await start(automationWorkflow, [leo.tenantId, id, "schedule:z", new Date().toISOString(), null, 1]);
    const { runs } = await run.returnValue;
    expect(runs.map((r) => r.kind)).toEqual(["done", "skipped", "skipped"]);
    expect(runs[1]).toEqual({ kind: "skipped", reason: "kill switch: incident" });
    expect(await runsOf(id)).toHaveLength(1);
  }, 60_000);

  it("fires drive-change automations watching the folder, once per document version", async () => {
    setAgentRuntime(runtime(scriptedTurns([{ text: "noted" }]).model));
    const watching = await automation({ trigger: "drive_change", folder: "/HR" });
    const other = await automation({ trigger: "drive_change", folder: "/Finance" });
    const doc = await document("/HR/Policies/leave.txt");
    expect(await fireDriveChange(leo.tenantId, doc, 1)).toBe(1);
    expect(await fireDriveChange(leo.tenantId, doc, 1)).toBe(1);
    await expect
      .poll(async () => (await runsOf(watching)).map((r) => r.status), { timeout: 20_000 })
      .toEqual(["succeeded"]);
    expect(await runsOf(other)).toEqual([]);
    expect(await t.sql`SELECT fire_key FROM automation_fires WHERE automation_id = ${watching}`).toEqual([
      { fire_key: `doc:${doc}:v1` },
    ]);
  }, 60_000);
});
