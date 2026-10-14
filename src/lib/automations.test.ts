// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Viewer } from "#learn/retrieve/types";

import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { claimFire, createAutomation, dueScheduleFires, listAutomations, setAutomationEnabled } from "./automations";

const LEO = "44444444-4444-4444-8444-444444444444";
const NORA = "55555555-5555-4555-8555-555555555555";

describe.skipIf(!postgresAvailable)("automations", () => {
  let t: TestDatabase;
  let leo: Viewer;
  let nora: Viewer;

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

  const inTenant = <T>(fn: Parameters<typeof withTenantOn<T>>[2]) => withTenantOn(t.appDb, leo.tenantId, fn);

  it("finds the due slot, and two schedulers claiming it at once fire it once", async () => {
    const id = await inTenant((tx) =>
      createAutomation(tx, leo, {
        name: "Hourly",
        prompt: "Check the inbox",
        trigger: { kind: "schedule", cron: "0 * * * *", folder: null },
      }),
    );
    await t.sql`UPDATE automations SET created_at = '2026-10-14T08:30:00Z' WHERE id = ${id}`;
    const now = new Date("2026-10-14T10:20:00Z");
    const due = (await dueScheduleFires(t.db, now)).filter((f) => f.automationId === id);
    expect(due).toEqual([
      {
        tenantId: leo.tenantId,
        automationId: id,
        fireKey: "schedule:2026-10-14T10:00:00.000Z",
        firedAt: new Date("2026-10-14T10:00:00Z"),
      },
    ]);

    const claims = await Promise.all(
      [1, 2, 3].map(() =>
        inTenant((tx) => claimFire(tx, id, due[0].fireKey, { firedAt: due[0].firedAt, documentIds: null })),
      ),
    );
    expect(claims.map((c) => c.kind).sort()).toEqual(["duplicate", "duplicate", "fire"]);
    expect(claims.find((c) => c.kind === "fire")).toMatchObject({ ownerId: LEO, items: [{ document: null }] });
    // A restart a moment later finds nothing new to fire.
    expect(
      (await dueScheduleFires(t.db, new Date("2026-10-14T10:21:00Z"))).filter((f) => f.automationId === id),
    ).toEqual([]);
  });

  it("lists only the owner's automations, and only the owner can turn one off; a disabled one doesn't fire", async () => {
    const id = await inTenant((tx) =>
      createAutomation(tx, leo, {
        name: "Watch HR",
        prompt: "Summarise it",
        trigger: { kind: "drive_change", folder: "/HR" },
      }),
    );
    expect((await inTenant((tx) => listAutomations(tx, leo))).map((a) => a.name)).toContain("Watch HR");
    expect(await inTenant((tx) => listAutomations(tx, nora))).toEqual([]);
    expect(await inTenant((tx) => setAutomationEnabled(tx, nora, id, false))).toBe(false);
    expect(await inTenant((tx) => setAutomationEnabled(tx, leo, id, false))).toBe(true);
    expect(await inTenant((tx) => claimFire(tx, id, "doc:x:v1", { firedAt: new Date(), documentIds: [] }))).toEqual({
      kind: "disabled",
    });
  });
});
