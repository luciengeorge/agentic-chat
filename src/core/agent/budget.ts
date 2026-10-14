/**
 * The checks a run's own events can't make: the kill switch and the user's daily token budget, both in Postgres.
 * A runner hands `createRunGuard` to `modelTurn` and `runTool`, which call it before every model turn and every
 * tool call.
 */
import { sql } from "drizzle-orm";

import type { Usage } from "#learn/model/types";
import type { Viewer } from "#learn/retrieve/types";
import type { Tx } from "@/db/tenant";

import { RunHalted, type RunGuard } from "./loop";

export const DEFAULT_DAILY_TOKENS = 500_000;

/** The UTC day a budget row counts: "2026-10-14". */
export const budgetDay = (now: Date) => now.toISOString().slice(0, 10);

/** The reason the tenant's agents are off (`agent_switches`), or null. No row means on. */
export async function switchedOff(tx: Tx, tenantId: string): Promise<string | null> {
  const [row] = await tx.execute<{ enabled: boolean; reason: string | null }>(sql`
    SELECT enabled, reason FROM agent_switches WHERE tenant_id = ${tenantId}`);
  return row && !row.enabled ? (row.reason ?? "switched off") : null;
}

/** Tokens the user has left today; a day with no row has the whole default. */
export async function budgetLeft(tx: Tx, viewer: Viewer, day: string, dailyTokens: number): Promise<number> {
  const [row] = await tx.execute<{ left: string }>(sql`
    SELECT token_limit - tokens_used AS left FROM agent_budgets
    WHERE tenant_id = ${viewer.tenantId} AND user_id = ${viewer.userId} AND day = ${day}`);
  return row ? Number(row.left) : dailyTokens;
}

/**
 * Adds a turn's tokens to the user's day in one upsert. The row's limit is set when the day's first turn creates
 * it, so raising one user's limit is an UPDATE of their row.
 */
export async function chargeBudget(tx: Tx, viewer: Viewer, day: string, tokens: number, dailyTokens: number) {
  await tx.execute(sql`
    INSERT INTO agent_budgets (tenant_id, user_id, day, tokens_used, token_limit)
    VALUES (${viewer.tenantId}, ${viewer.userId}, ${day}, ${tokens}, ${dailyTokens})
    ON CONFLICT (tenant_id, user_id, day)
    DO UPDATE SET tokens_used = agent_budgets.tokens_used + EXCLUDED.tokens_used, updated_at = now()`);
}

export interface RunGuardDeps {
  withTenant: <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;
  viewer: Viewer;
  /** `AGENT_KILL_SWITCH=1`: every tenant's agents stop. */
  killedEverywhere: boolean;
  dailyTokens?: number;
  now?: () => Date;
}

/**
 * The kill switch before every model turn and tool call; the budget checked before each model turn and charged
 * after it. A check and a charge are separate statements, so two turns at once can both pass the check and spend
 * past the limit by a turn. The next check stops the run.
 */
export function createRunGuard(deps: RunGuardDeps): RunGuard {
  const { viewer, dailyTokens = DEFAULT_DAILY_TOKENS, now = () => new Date() } = deps;

  async function killSwitch(tx: Tx) {
    if (deps.killedEverywhere) throw new RunHalted("kill switch: agents are switched off");
    const reason = await switchedOff(tx, viewer.tenantId);
    if (reason !== null) throw new RunHalted(`kill switch: ${reason}`);
  }

  return {
    beforeModelTurn: () =>
      deps.withTenant(viewer.tenantId, async (tx) => {
        await killSwitch(tx);
        if ((await budgetLeft(tx, viewer, budgetDay(now()), dailyTokens)) <= 0) {
          throw new RunHalted("daily token budget spent");
        }
      }),
    afterModelTurn: (usage: Usage) =>
      deps.withTenant(viewer.tenantId, (tx) =>
        chargeBudget(tx, viewer, budgetDay(now()), (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0), dailyTokens),
      ),
    beforeToolCall: () => deps.withTenant(viewer.tenantId, killSwitch),
  };
}
