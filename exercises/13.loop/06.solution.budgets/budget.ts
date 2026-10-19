/**
 * The checks a run's own events can't make: the kill switch and the user's daily token budget, both in Postgres.
 * A runner hands `createRunGuard` to `modelTurn` and `runTool`, which call it before every model turn and every
 * tool call.
 */
import { sql } from "drizzle-orm";

import type { Viewer } from "#learn/retrieve/types";
import type { Tx } from "@/db/tenant";

import { RunHalted, type RunGuard, type TokenHold } from "#learn/agent/loop";

export const DEFAULT_DAILY_TOKENS = 500_000;

/** The UTC day a budget row counts: "2026-10-14". */
export const budgetDay = (now: Date) => now.toISOString().slice(0, 10);

/** The reason the tenant's agents are off (`agent_switches`), or null. No row means on. */
export async function switchedOff(tx: Tx, tenantId: string): Promise<string | null> {
  const [row] = await tx.execute<{ enabled: boolean; reason: string | null }>(sql`
    SELECT enabled, reason FROM agent_switches WHERE tenant_id = ${tenantId}`);
  return row && !row.enabled ? (row.reason ?? "switched off") : null;
}

/** Tokens the user has left today, before what's held; a day with no row has the whole default. */
export async function budgetLeft(tx: Tx, viewer: Viewer, day: string, dailyTokens: number): Promise<number> {
  const [row] = await tx.execute<{ left: string }>(sql`
    SELECT token_limit - tokens_used AS left FROM agent_budgets
    WHERE tenant_id = ${viewer.tenantId} AND user_id = ${viewer.userId} AND day = ${day}`);
  return row ? Number(row.left) : dailyTokens;
}

/** How long a hold counts. Longer than any model call (the Workflow step times out at 120 s), so only a hold whose
 * process died before settling it ever lapses. */
export const HOLD_MS = 5 * 60_000;

/** The row's holds that haven't lapsed at `at`: `{ "<id>": { tokens, until } }`. */
export const liveHolds = (at: string) => sql`COALESCE((
  SELECT jsonb_object_agg(k, v) FROM jsonb_each(agent_budgets.holds) AS h(k, v)
  WHERE (v->>'until')::timestamptz > ${at}::timestamptz), '{}'::jsonb)`;
export const heldTokens = (at: string) => sql`COALESCE((
  SELECT sum((v->>'tokens')::bigint) FROM jsonb_each(agent_budgets.holds) AS h(k, v)
  WHERE (v->>'until')::timestamptz > ${at}::timestamptz), 0)`;

/**
 * Holds `tokens` of the user's day for one model call, in one statement, or returns null when they aren't left.
 * The upsert locks the day's row and reads its latest version, so two calls at once take turns: the second sees
 * the first one's hold. What's left is the limit, less what's used, less the holds still live. A day with no row
 * yet starts from `dailyTokens`. Lapsed holds (a process that died mid-call) are dropped on the way.
 */
export async function holdBudget(
  tx: Tx,
  viewer: Viewer,
  day: string,
  tokens: number,
  dailyTokens: number,
  now: Date,
): Promise<TokenHold | null> {
  const id = crypto.randomUUID();
  const at = now.toISOString();
  const hold = JSON.stringify({ [id]: { tokens, until: new Date(now.getTime() + HOLD_MS).toISOString() } });
  const rows = await tx.execute(sql`
    INSERT INTO agent_budgets (tenant_id, user_id, day, tokens_used, token_limit, holds)
    SELECT ${viewer.tenantId}, ${viewer.userId}, ${day}, 0, ${dailyTokens}, ${hold}::jsonb
    WHERE ${dailyTokens}::bigint >= ${tokens}::bigint OR EXISTS (
      SELECT 1 FROM agent_budgets
      WHERE tenant_id = ${viewer.tenantId} AND user_id = ${viewer.userId} AND day = ${day})
    ON CONFLICT (tenant_id, user_id, day) DO UPDATE
    SET holds = ${liveHolds(at)} || EXCLUDED.holds, updated_at = now()
    WHERE agent_budgets.token_limit - agent_budgets.tokens_used - ${heldTokens(at)} >= ${tokens}::bigint
    RETURNING 1`);
  return rows.length > 0 ? { id, day, tokens } : null;
}

/**
 * Settles a hold: adds what the call really used to the user's day and drops the hold, in one upsert. A call that
 * failed settles with 0, which gives the hold back. Without a hold (a guard used without one), it only charges.
 * The row's limit is set when the day's first call creates it, so raising one user's limit is an UPDATE of their
 * row.
 */
export async function settleBudget(
  tx: Tx,
  viewer: Viewer,
  day: string,
  tokens: number,
  dailyTokens: number,
  hold: TokenHold | null,
) {
  await tx.execute(sql`
    INSERT INTO agent_budgets (tenant_id, user_id, day, tokens_used, token_limit)
    VALUES (${viewer.tenantId}, ${viewer.userId}, ${day}, ${tokens}, ${dailyTokens})
    ON CONFLICT (tenant_id, user_id, day)
    DO UPDATE SET tokens_used = agent_budgets.tokens_used + EXCLUDED.tokens_used,
                  holds = agent_budgets.holds - ${hold?.id ?? ""}::text, updated_at = now()`);
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
 * The kill switch before every model turn and tool call. Before each model call, the budget holds the call's
 * estimate (`turnEstimate`: its request plus its most output) in one statement, and refuses the call when that
 * isn't left; after it, the hold is settled to the real usage, or given back if the call failed. So turns running
 * at once can't spend past the limit together. Called with no estimate, it holds one token: a plain check.
 */
export function createRunGuard(deps: RunGuardDeps): RunGuard {
  const { viewer, dailyTokens = DEFAULT_DAILY_TOKENS, now = () => new Date() } = deps;

  async function killSwitch(tx: Tx) {
    if (deps.killedEverywhere) throw new RunHalted("kill switch: agents are switched off");
    const reason = await switchedOff(tx, viewer.tenantId);
    if (reason !== null) throw new RunHalted(`kill switch: ${reason}`);
  }

  return {
    beforeModelTurn: (estimate = 1) =>
      deps.withTenant(viewer.tenantId, async (tx) => {
        await killSwitch(tx);
        const at = now();
        const hold = await holdBudget(tx, viewer, budgetDay(at), Math.max(1, Math.ceil(estimate)), dailyTokens, at);
        if (!hold) throw new RunHalted("daily token budget spent");
        return hold;
      }),
    afterModelTurn: (usage, hold) =>
      deps.withTenant(viewer.tenantId, (tx) =>
        settleBudget(
          tx,
          viewer,
          hold ? hold.day : budgetDay(now()),
          usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : 0,
          dailyTokens,
          hold || null,
        ),
      ),
    beforeToolCall: () => deps.withTenant(viewer.tenantId, killSwitch),
  };
}
