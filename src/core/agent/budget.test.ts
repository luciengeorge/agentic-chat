// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { scriptedTurns } from "#learn/model/testing";
import { type Tx, withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { budgetLeft, createRunGuard, HOLD_MS } from "./budget";
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
        maxOutputTokens: 50,
        guard: g,
      },
    );
  const row = async () => {
    const [r] = await t.sql`SELECT tokens_used, holds FROM agent_budgets WHERE user_id = ${LEO}`;
    return r as { tokens_used: string; holds: Record<string, { tokens: number }> } | undefined;
  };

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

  it("holds a turn's estimate in one statement, so concurrent turns can't spend past the limit", async () => {
    const g = guard({ dailyTokens: 10_000 });
    const tries = await Promise.allSettled(Array.from({ length: 5 }, () => g.beforeModelTurn(4_000)));
    expect(tries.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(tries.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason)).toEqual(
      Array.from({ length: 3 }, () => new RunHalted("daily token budget spent")),
    );
    expect(Object.values((await row())!.holds).map((h) => h.tokens)).toEqual([4_000, 4_000]);
  });

  it("settles a hold to the turn's real usage", async () => {
    const g = guard({ dailyTokens: 10_000 });
    const hold = await g.beforeModelTurn(6_000);
    await g.afterModelTurn({ inputTokens: 900, outputTokens: 100, reasoningTokens: 0 }, hold);
    expect(await row()).toEqual({ tokens_used: "1000", holds: {} });
    // The 6,000 held is back: another 6,000 fits in what's left (9,000).
    await expect(g.beforeModelTurn(6_000)).resolves.toMatchObject({ tokens: 6_000 });
  });

  it("gives the hold back when the model call fails", async () => {
    const failing = {
      id: "failing",
      // oxlint-disable-next-line require-yield
      async *stream(): AsyncGenerator<never> {
        throw new Error("503 from the provider");
      },
    };
    await expect(
      modelTurn(
        { instructions: "", messages: [{ role: "user", content: "hi" }] },
        { model: failing, tools: [], reasoningEffort: "low", guard: guard() },
      ),
    ).rejects.toThrow("503");
    expect(await row()).toEqual({ tokens_used: "0", holds: {} });
  });

  it("lets a hold left by a crash lapse, so it can't lock the user out for the day", async () => {
    const noon = new Date("2026-10-14T12:00:00Z");
    now = noon;
    const g = guard({ dailyTokens: 10_000 });
    await g.beforeModelTurn(8_000);
    await expect(g.beforeModelTurn(8_000)).rejects.toThrow(RunHalted);
    now = new Date(noon.getTime() + HOLD_MS + 1);
    await expect(g.beforeModelTurn(8_000)).resolves.toMatchObject({ tokens: 8_000 });
    expect(Object.keys((await row())!.holds)).toHaveLength(1);
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
