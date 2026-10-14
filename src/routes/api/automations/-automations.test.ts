// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Viewer } from "#learn/retrieve/types";
import type { DueFire } from "@/lib/automations";

import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import {
  type AutomationRoutesDeps,
  handleCreateAutomation,
  handleListAutomations,
  handleRunNow,
  handleSetEnabled,
  RUN_NOW_BUCKET,
} from "./-automations";

const LEO = "44444444-4444-4444-8444-444444444444";
const NORA = "55555555-5555-4555-8555-555555555555";

describe.skipIf(!postgresAvailable)("the automation routes", () => {
  let t: TestDatabase;
  let leo: Viewer;
  let nora: Viewer;
  const fired: DueFire[] = [];

  const deps = (): AutomationRoutesDeps => ({ db: t.appDb, fire: async (fire) => fired.push(fire) });
  const request = (method: string, body: unknown) =>
    new Request("http://localhost:3000/api/automations", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

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

  it("creates, lists, disables and fires an automation; only its owner can", async () => {
    const bad = await handleCreateAutomation(
      request("POST", { name: "x", prompt: "y", trigger: { kind: "schedule", cron: "every day", folder: null } }),
      leo,
      deps(),
    );
    expect(bad.status).toBe(400);

    const created = await handleCreateAutomation(
      request("POST", {
        name: "Morning digest",
        prompt: "Summarise what's new",
        trigger: { kind: "schedule", cron: "0 8 * * 1-5", folder: "HR/Policies" },
      }),
      leo,
      deps(),
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const list = (await (await handleListAutomations(leo, deps())).json()) as { automations: unknown[] };
    expect(list.automations).toEqual([
      expect.objectContaining({
        id,
        name: "Morning digest",
        enabled: true,
        trigger: { kind: "schedule", cron: "0 8 * * 1-5", folder: "/HR/Policies" },
        lastRun: null,
      }),
    ]);
    expect(
      ((await (await handleListAutomations(nora, deps())).json()) as { automations: unknown[] }).automations,
    ).toEqual([]);

    expect((await handleRunNow(nora, id, deps())).status).toBe(404);
    expect((await handleRunNow(leo, id, deps())).status).toBe(202);
    expect(fired).toEqual([expect.objectContaining({ tenantId: leo.tenantId, automationId: id })]);
    expect(fired[0].fireKey).toMatch(/^manual:/);

    expect((await handleSetEnabled(request("PATCH", { enabled: false }), nora, id, deps())).status).toBe(404);
    expect((await handleSetEnabled(request("PATCH", { enabled: false }), leo, id, deps())).status).toBe(200);
    expect((await handleRunNow(leo, id, deps())).status).toBe(409);
  });

  it("rate-limits Run now per user, with Retry-After", async () => {
    const created = await handleCreateAutomation(
      request("POST", {
        name: "digest",
        prompt: "summarise",
        trigger: { kind: "schedule", cron: "0 9 * * 1", folder: null },
      }),
      nora,
      deps(),
    );
    const { id } = (await created.json()) as { id: string };
    const at = new Date("2026-10-14T12:00:00Z");
    const runNow = () => handleRunNow(nora, id, { ...deps(), now: () => at });
    for (let i = 0; i < RUN_NOW_BUCKET.capacity; i++) expect((await runNow()).status).toBe(202);
    const refused = await runNow();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe(String(Math.ceil(1 / RUN_NOW_BUCKET.refillPerSecond)));
    expect(await refused.json()).toMatchObject({ error: "rate_limited" });
    expect(fired.filter((f) => f.automationId === id)).toHaveLength(RUN_NOW_BUCKET.capacity);
  });
});
