// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { scriptedTurns } from "#learn/model/testing";
import { type Tx, withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { budgetLeft, createRunGuard } from "./budget";
import { modelTurn, RunHalted } from "./loop";

const LEO = "44444444-4444-4444-8444-444444444444";
const NINA = "55555555-5555-4555-8555-555555555555";
const DAY1 = new Date("2026-10-14T23:59:00Z");
const DAY2 = new Date("2026-10-15T00:01:00Z");

describe.skipIf(!postgresAvailable)("the run guard (kill switch and daily budget in Postgres)", () => {
  let t: TestDatabase;
  let kestrel: string;
  let harbour: string;
  let now = DAY1;

  const withTenant = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => withTenantOn(t.appDb, tenantId, fn);
  const leo = () => ({ tenantId: kestrel, userId: LEO });
  const guard = (options: { killedEverywhere?: boolean; dailyTokens?: number } = {}) =>
    createRunGuard({ withTenant, viewer: leo(), killedEverywhere: false, now: () => now, ...options });
  const turn = (g = guard()) =>
    modelTurn(
      { instructions: "", messages: [{ role: "user", content: "hi" }] },
      {
        model: scriptedTurns([{ text: "ok", inputTokens: 300, outputTokens: 20 }]).model,
        tools: [],
        reasoningEffort: "low",
        guard: g,
      },
    );

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: kestrel }, { id: harbour }] = await t.sql`
      INSERT INTO organization (name, slug, created_at)
      VALUES ('Kestrel Pay', 'kestrel', now()), ('Harbour Health', 'harbour', now()) RETURNING id`;
    for (const [id, tenant, name] of [
      [LEO, kestrel, "leo.martin"],
      [NINA, harbour, "nina.osei"],
    ]) {
      await t.sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, enabled, synced_at)
                  VALUES (${id}, ${tenant}, 'user', ${id}, ${name}, ${name}, true, now())`;
    }
  });

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    now = DAY1;
    await t.sql`DELETE FROM agent_budgets`;
    await t.sql`DELETE FROM agent_switches`;
  });

  it("charges each model turn's tokens to the user's day", async () => {
    await turn();
    await turn();
    const left = await withTenant(kestrel, (tx) => budgetLeft(tx, leo(), "2026-10-14", 500_000));
    expect(left).toBe(500_000 - 640);
    const [row] = await t.sql`SELECT tokens_used, token_limit FROM agent_budgets WHERE user_id = ${LEO}`;
    expect(row).toEqual({ tokens_used: "640", token_limit: "500000" });
  });

  it("stops a turn once the day's budget is spent, and starts afresh the next day", async () => {
    const small = guard({ dailyTokens: 500 });
    await turn(small);
    await turn(small);
    await expect(turn(small)).rejects.toThrow(new RunHalted("daily token budget spent"));
    now = DAY2;
    await expect(turn(small)).resolves.toMatchObject({ type: "assistant_turn" });
  });

  it("honours a raised limit on the user's row", async () => {
    await turn(guard({ dailyTokens: 300 }));
    await expect(turn(guard({ dailyTokens: 300 }))).rejects.toThrow(RunHalted);
    await t.sql`UPDATE agent_budgets SET token_limit = 10000 WHERE user_id = ${LEO}`;
    await expect(turn(guard({ dailyTokens: 300 }))).resolves.toMatchObject({ type: "assistant_turn" });
  });

  it("stops model turns and tool calls when the tenant's switch is off, and only that tenant's", async () => {
    await t.sql`INSERT INTO agent_switches (tenant_id, enabled, reason) VALUES (${kestrel}, false, 'incident 42')`;
    await expect(guard().beforeModelTurn()).rejects.toThrow("kill switch: incident 42");
    await expect(guard().beforeToolCall()).rejects.toThrow("kill switch: incident 42");
    const nina = createRunGuard({ withTenant, viewer: { tenantId: harbour, userId: NINA }, killedEverywhere: false });
    await expect(nina.beforeToolCall()).resolves.toBeUndefined();

    await t.sql`UPDATE agent_switches SET enabled = true WHERE tenant_id = ${kestrel}`;
    await expect(guard().beforeToolCall()).resolves.toBeUndefined();
  });

  it("stops everyone with AGENT_KILL_SWITCH", async () => {
    await expect(guard({ killedEverywhere: true }).beforeModelTurn()).rejects.toThrow(RunHalted);
    await expect(guard({ killedEverywhere: true }).beforeToolCall()).rejects.toThrow(RunHalted);
  });
});
