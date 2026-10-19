// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ChatModel } from "#learn/model/types";

import { budgetLeft, createRunGuard, HOLD_MS } from "#learn/agent/budget";
import { buildContext } from "#learn/agent/context";
import { modelTurn, RunHalted } from "#learn/agent/loop";
import { AGENT_INSTRUCTIONS } from "#learn/agent/prompt";
import { scriptedTurns } from "#learn/model/testing";
import { recordedRun, replayAgentModel, replayTools } from "@/core/agent/loop-recorded";
import { type Tx, withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

const GRACE = "50e2b299-7468-577d-a8e3-ed6e5bdb9f0f";
const NINA = "55555555-5555-4555-8555-555555555555";
const DAY1 = new Date("2026-10-19T23:59:00Z");
const DAY2 = new Date("2026-10-20T00:01:00Z");

describe.skipIf(!postgresAvailable)("the daily budget and the kill switch, in Postgres", () => {
  let t: TestDatabase;
  let kestrel: string;
  let harbour: string;
  let now = DAY1;

  const withTenant = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => withTenantOn(t.appDb, tenantId, fn);
  const grace = () => ({ tenantId: kestrel, userId: GRACE });
  const guard = (options: { killedEverywhere?: boolean; dailyTokens?: number } = {}) =>
    createRunGuard({ withTenant, viewer: grace(), killedEverywhere: false, now: () => now, ...options });
  /** One model turn of 300 tokens in and 20 out, with at most 50 out: a hold of the request plus 50. */
  const turn = (
    g = guard(),
    model: ChatModel = scriptedTurns([{ text: "ok", inputTokens: 300, outputTokens: 20 }]).model,
  ) =>
    modelTurn(
      { instructions: "", messages: [{ role: "user", content: "hi" }] },
      { model, tools: [], reasoningEffort: "low", maxOutputTokens: 50, guard: g },
    );
  /** What a check did: "allowed", or what it threw. */
  const outcome = (check: Promise<unknown>) =>
    check.then(
      () => "allowed",
      (error: unknown) => error,
    );
  const row = async () => {
    const [r] = await t.sql`SELECT tokens_used, holds FROM agent_budgets WHERE user_id = ${GRACE}`;
    return r as { tokens_used: string; holds: Record<string, { tokens: number }> } | undefined;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: kestrel }, { id: harbour }] = await t.sql`
      INSERT INTO organization (name, slug, created_at)
      VALUES ('Kestrel Pay', 'kestrel', now()), ('Harbour Health', 'harbour', now()) RETURNING id`;
    for (const [id, tenant, name] of [
      [GRACE, kestrel, "grace.adeyemi"],
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

  describe("the daily budget", () => {
    it("charges each model turn's tokens to the user's day", async () => {
      await turn();
      await turn();
      expect(await withTenant(kestrel, (tx) => budgetLeft(tx, grace(), "2026-10-19", 500_000))).toBe(500_000 - 640);
      const [r] = await t.sql`SELECT tokens_used, token_limit, holds FROM agent_budgets WHERE user_id = ${GRACE}`;
      expect(r, "two turns of 320, and no hold left behind").toEqual({
        tokens_used: "640",
        token_limit: "500000",
        holds: {},
      });
    });

    it("refuses a turn once the day is spent, and starts afresh the next day", async () => {
      const small = guard({ dailyTokens: 500 });
      await turn(small);
      await turn(small);
      expect(await outcome(turn(small)), "640 of 500 used: the day is spent, so the next turn is refused").toEqual(
        new RunHalted("daily token budget spent"),
      );
      now = DAY2;
      await expect(turn(small), "a new UTC day has its own row").resolves.toMatchObject({ type: "assistant_turn" });
    });

    it("honours a limit raised on the user's row", async () => {
      await turn(guard({ dailyTokens: 300 }));
      await expect(turn(guard({ dailyTokens: 300 }))).rejects.toThrow(RunHalted);
      await t.sql`UPDATE agent_budgets SET token_limit = 10000 WHERE user_id = ${GRACE}`;
      await expect(
        turn(guard({ dailyTokens: 300 })),
        "the row's token_limit is the one that counts",
      ).resolves.toMatchObject({ type: "assistant_turn" });
    });

    it("holds against a raised limit even when the hold is more than the default", async () => {
      await t.sql`INSERT INTO agent_budgets (tenant_id, user_id, day, tokens_used, token_limit)
                  VALUES (${kestrel}, ${GRACE}, '2026-10-19', 0, 10000)`;
      expect(
        await outcome(guard({ dailyTokens: 100 }).beforeModelTurn(4_000)),
        "4,000 of a 10,000 limit was refused because the default is 100. When the day has a row, the insert must " +
          "still reach ON CONFLICT, where the row's own limit decides: insert when `dailyTokens` covers the hold OR " +
          "the row exists",
      ).toBe("allowed");
      expect(Object.values((await row())!.holds).map((h) => h.tokens)).toEqual([4_000]);
    });

    it("holds in one statement, so five turns at once against room for two give two", async () => {
      const g = guard({ dailyTokens: 10_000 });
      const tries = await Promise.allSettled(Array.from({ length: 5 }, () => g.beforeModelTurn(4_000)));
      expect(
        tries.filter((r) => r.status === "fulfilled"),
        "reading what's left, then writing the hold, lets every turn see the same room",
      ).toHaveLength(2);
      expect(tries.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason)).toEqual(
        Array.from({ length: 3 }, () => new RunHalted("daily token budget spent")),
      );
      expect(Object.values((await row())!.holds).map((h) => h.tokens)).toEqual([4_000, 4_000]);
    });

    it("counts the holds of turns still running against what's left", async () => {
      const g = guard({ dailyTokens: 10_000 });
      await g.beforeModelTurn(6_000);
      expect(await outcome(g.beforeModelTurn(6_000)), "6,000 held and 6,000 more is past 10,000").toEqual(
        expect.any(RunHalted),
      );
    });

    it("settles a hold to what the call used", async () => {
      const g = guard({ dailyTokens: 10_000 });
      const hold = await g.beforeModelTurn(6_000);
      await g.afterModelTurn({ inputTokens: 900, outputTokens: 100, reasoningTokens: 0 }, hold);
      expect(await row(), "1,000 used, and the hold is gone").toEqual({ tokens_used: "1000", holds: {} });
      await expect(g.beforeModelTurn(6_000), "9,000 left: 6,000 fits again").resolves.toMatchObject({ tokens: 6_000 });
    });

    it("settles on the day the hold was taken, even when the call ends after midnight", async () => {
      const g = guard({ dailyTokens: 10_000 });
      const hold = await g.beforeModelTurn(3_000);
      now = DAY2;
      await g.afterModelTurn({ inputTokens: 900, outputTokens: 100, reasoningTokens: 0 }, hold);
      const rows = await t.sql`SELECT day::text, tokens_used, holds FROM agent_budgets WHERE user_id = ${GRACE}`;
      expect(rows, "the usage goes where the hold went on, and the hold comes off there").toEqual([
        { day: "2026-10-19", tokens_used: "1000", holds: {} },
      ]);
    });

    it("gives the hold back when the model call fails", async () => {
      const failing: ChatModel = {
        id: "failing",
        // oxlint-disable-next-line require-yield
        async *stream() {
          throw new Error("503 from the provider");
        },
      };
      await expect(turn(guard(), failing)).rejects.toThrow("503");
      expect(await row()).toEqual({ tokens_used: "0", holds: {} });
    });

    it("lets a hold lapse after HOLD_MS, so a crashed call can't lock the user out", async () => {
      const noon = new Date("2026-10-19T12:00:00Z");
      now = noon;
      const g = guard({ dailyTokens: 10_000 });
      await g.beforeModelTurn(8_000);
      await expect(g.beforeModelTurn(8_000)).rejects.toThrow(RunHalted);
      now = new Date(noon.getTime() + HOLD_MS + 1);
      await expect(g.beforeModelTurn(8_000), "the first hold has lapsed").resolves.toMatchObject({ tokens: 8_000 });
      expect(Object.keys((await row())!.holds), "the lapsed hold is dropped from the row").toHaveLength(1);
    });
  });

  describe("the kill switch", () => {
    it("stops model turns and tool calls when the tenant's switch is off, and only that tenant's", async () => {
      await t.sql`INSERT INTO agent_switches (tenant_id, enabled, reason) VALUES (${kestrel}, false, 'incident 42')`;
      await expect(guard().beforeModelTurn()).rejects.toThrow(new RunHalted("kill switch: incident 42"));
      expect(
        await outcome(guard().beforeToolCall()),
        "checked before every tool call too: a run halfway through its calls would keep going",
      ).toEqual(new RunHalted("kill switch: incident 42"));
      const nina = createRunGuard({ withTenant, viewer: { tenantId: harbour, userId: NINA }, killedEverywhere: false });
      await expect(nina.beforeToolCall(), "Harbour's agents run on").resolves.toBeUndefined();
      await t.sql`UPDATE agent_switches SET enabled = true WHERE tenant_id = ${kestrel}`;
      await expect(guard().beforeToolCall()).resolves.toBeUndefined();
    });

    it("stops everyone with AGENT_KILL_SWITCH", async () => {
      const off = new RunHalted("kill switch: agents are switched off");
      expect(await outcome(guard({ killedEverywhere: true }).beforeModelTurn()), "AGENT_KILL_SWITCH=1").toEqual(off);
      expect(await outcome(guard({ killedEverywhere: true }).beforeToolCall()), "and before tool calls").toEqual(off);
    });
  });

  describe("Grace's recorded run", () => {
    it("holds 6,033 tokens while her planning turn runs, then charges the 1,970 it used", async () => {
      const recording = recordedRun("kpc-terms");
      const replay = replayAgentModel("kpc-terms").model;
      let held: number[] = [];
      const watched: ChatModel = {
        id: replay.id,
        async *stream(request) {
          held = Object.values((await row())!.holds).map((h) => h.tokens);
          yield* replay.stream(request);
        },
      };
      const turn = await modelTurn(
        buildContext(recording.events.slice(0, 1), undefined, { instructions: AGENT_INSTRUCTIONS }),
        {
          model: watched,
          tools: replayTools("kpc-terms"),
          reasoningEffort: "medium",
          guard: guard(),
        },
      );
      expect(turn.usage).toMatchObject({ inputTokens: 1865, outputTokens: 105 });
      expect(held, "the request's 2,033 tokens plus 4,000 for the longest answer").toEqual([6_033]);
      expect(await row(), "settled: what the turn used, and nothing held").toEqual({ tokens_used: "1970", holds: {} });
    });
  });
});
