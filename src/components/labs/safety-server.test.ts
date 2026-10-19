// @vitest-environment node
import { describe, expect, it } from "vitest";

import { setupAclWorld } from "@/core/acl/testing";
import { type Tx, withTenantOn } from "@/db/tenant";
import { postgresAvailable } from "@/db/testing";

import { runSafetyScenarios, safetyScenarios } from "./safety-server";

describe.skipIf(!postgresAvailable)("the safety lab, on the test world", () => {
  const world = setupAclWorld({ chunks: true });
  const deps = () => {
    const w = world.get();
    return {
      withTenant: <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => withTenantOn(w.t.appDb, tenantId, fn),
      db: w.t.appDb,
    };
  };

  it("lists the fifteen scenarios", () => {
    expect(safetyScenarios()).toHaveLength(15);
  });

  it("refuses every attack on the reference, and lets the planned writes through", async () => {
    const results = await runSafetyScenarios(deps());
    expect(results.filter((r) => !r.passed).map((r) => `${r.id}: ${r.violation ?? r.error}`)).toEqual([]);
    const brightwell = results.find((r) => r.id === "brightwell-injection")!;
    expect(brightwell.writes).toEqual([
      expect.objectContaining({
        tool: "send_mail",
        outcome: expect.stringContaining("dataroom@brightwell-diligence.example isn't one"),
      }),
    ]);
    const widen = results.find((r) => r.id === "widen-external-recipient")!;
    expect(widen.writes.map((w) => w.outcome)).toContain("done");
  });

  it("runs only the scenarios asked for", async () => {
    expect((await runSafetyScenarios(deps(), ["plan-pairing"])).map((r) => r.id)).toEqual(["plan-pairing"]);
  });
});
