// 👨‍💼 Caps stop one run. They don't stop Grace starting forty. Every user has a daily allowance of model tokens
//    (500,000 by default), and Kestrel has a switch that stops its agents at once when something goes wrong. Both
//    live in Postgres, so every runner on every server sees the same numbers.
//
// 🦉 Already written in this file: `switchedOff` (the tenant's switch), `budgetLeft`, `settleBudget` (adds what a
//    call used and drops its hold, in one upsert), and `liveHolds` and `heldTokens`, SQL for the holds that
//    haven't lapsed. `modelTurn` and `runTool` call the guard you build. You write `holdBudget` and
//    `createRunGuard`.

/**
 * The checks a run's own events can't make: the kill switch and the user's daily token budget, both in Postgres.
 * A runner hands `createRunGuard` to `modelTurn` and `runTool`, which call it before every model turn and every
 * tool call.
 */
import { sql } from "drizzle-orm";

import type { Viewer } from "#learn/retrieve/types";
import type { Tx } from "@/db/tenant";

import { type RunGuard, type TokenHold } from "#learn/agent/loop";

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
  // 🐨 In one statement, hold `tokens` of the user's day, or hold nothing when they aren't left. What's left is the
  //    row's `token_limit`, less its `tokens_used`, less the tokens of the holds still live at `now`.
  // 🐨 A day with no row yet starts at `dailyTokens`: insert the row with this hold in it, if `dailyTokens` covers
  //    it. A day that has a row: keep its live holds (the lapsed ones go) and add this one, if what's left covers
  //    it.
  // 🐨 A hold is `{ "<id>": { tokens, until } }` in the row's `holds` (jsonb), with `until` `HOLD_MS` after `now`.
  //    Return `{ id, day, tokens }` when the hold was taken, null when it wasn't.
  // 🐨 The classic mistake: reading what's left, then writing the hold, in two statements. Five turns at once all
  //    read the same number, all see room, and all go ahead.
  //
  // 💰 `INSERT ... SELECT ... WHERE <condition>` inserts nothing when the condition is false.
  //    `ON CONFLICT (tenant_id, user_id, day) DO UPDATE SET ... WHERE <condition>` updates nothing when it's false;
  //    in it, `agent_budgets.<column>` is the row already there and `EXCLUDED.<column>` the row you tried to insert.
  //    `RETURNING 1` returns a row only when one was written. In jsonb, `a || b` merges two objects.
  //    `${liveHolds(at)}` and `${heldTokens(at)}` drop into the statement as the row's live holds and their sum.
  //    `crypto.randomUUID()`.
  //
  // 🦉 Why one statement. An upsert takes the row's lock. A second upsert on the same row waits, then reads the row
  //    as the first one left it, holds and all. So no other turn can come between the check and the hold, and five
  //    turns at once against room for two give exactly two.
  // 🦉 Why hold before the call. Nobody knows what a call costs until it's over. Checking "is there budget?"
  //    without holding any lets every turn in flight spend the same last tokens: on 14 October, before holds,
  //    leo.martin's day reached 507,000 of 500,000 that way. A hold is the most the call can cost (`turnEstimate`:
  //    the request, plus its longest answer), and settling gives back what it didn't use.
  // 🦉 Why holds lapse. A process killed mid-call never settles its hold. Without `until`, those tokens would stay
  //    held until midnight UTC. Five minutes is longer than any model call (the longest step gives up at 120 s).
  //
  // 🚨 The tests check turns charged, a spent day, a new day, a raised limit, five holds at once against room for
  //    two, a hold settled and one given back, a lapsed hold, and Grace's first turn holding 6,033 tokens.
  throw new Error(
    `holdBudget(${typeof tx}, ${viewer.userId}, ${day}, ${tokens} of ${dailyTokens}, ${now.toISOString()}) isn't written yet`,
  );
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
  // 🐨 Return the three checks `modelTurn` and `runTool` call:
  //    - `beforeModelTurn(estimate = 1)`: in one tenant transaction, the kill switch, then a hold on the estimate
  //      (rounded up, at least 1) for today, `budgetDay(now())`. No hold: throw `RunHalted("daily token budget
  //      spent")`. Otherwise return the hold;
  //    - `afterModelTurn(usage, hold)`: settle on the hold's day what the call used, input plus output (0 when
  //      `usage` is null, which gives the hold back);
  //    - `beforeToolCall()`: the kill switch alone.
  // 🐨 The kill switch: `deps.killedEverywhere` (`AGENT_KILL_SWITCH=1`) throws `RunHalted("kill switch: agents are
  //    switched off")`; the tenant's own switch (`switchedOff`) throws `RunHalted("kill switch: <its reason>")`.
  // 🐨 The classic mistake: checking the switch before model turns only. A run halfway through a turn's calls
  //    would keep sending mail after the switch is thrown.
  //
  // 💰 `deps.withTenant(viewer.tenantId, async (tx) => ...)`. `Math.ceil`. `settleBudget(tx, viewer, day, tokens,
  //    dailyTokens, hold || null)`. Add `RunHalted` to the `#learn/agent/loop` import.
  //
  // 🦉 Why `RunHalted`. `runTool` hands every other error to the model. A kill switch handed to the model reads as
  //    "that tool failed, try another way". Thrown as `RunHalted`, it passes through, and the runner fails the run
  //    with the reason.
  // 🦉 Why the hold's day. A call that starts at 23:59:58 UTC and ends after midnight was held on one day's row,
  //    so its usage goes on that row too, and the hold comes off where it went on.
  //
  // 🚨 The tests check the switch before model turns and tool calls, for one tenant and for everyone, and the
  //    budget through real model turns.
  throw new Error(`createRunGuard(${viewer.userId}, ${dailyTokens}, ${now().toISOString()}) isn't written yet`);
}
