/**
 * Section 16's live proof, in-process: real models, the dev database, Workflow's test world (not the dev server's).
 * Skipped unless asked for, since it costs money:
 *
 *   AC_LIVE_PROOF=1 pnpm exec dotenv -e .env.local -- vitest run --project workflows src/workflows/orchestration-live.test.ts
 *
 * As a Kestrel user (amara.okafor unless AC_LIVE_USER says): the router on four real messages, one orchestrated comparison with two sub-agents, and one
 * automation fire. It prints what each did and what it cost.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { start } from "workflow/api";

import type { RunEvent } from "#learn/agent/types";

import { routeMessage } from "#learn/agent/router";
import { appDb } from "@/db/pool";
import { withTenantOn } from "@/db/tenant";
import { loadState, startRun } from "@/lib/agent-runs";
import { chatModelFromEnv } from "@/routes/api/chat/-deps";

import { agentRunWorkflow } from "./agent-run";
import { automationWorkflow } from "./automation";

/** gpt-6-luna, USD per million tokens (as scripts/eval.ts). */
const PRICE = { input: 0.1, output: 0.5 };

const live = process.env.AC_LIVE_PROOF === "1";
/** Whose runs: any Kestrel user who can read both policies. */
const USER = process.env.AC_LIVE_USER ?? "amara.okafor";

function cost(usage: { input: number; output: number }) {
  return (usage.input * PRICE.input + usage.output * PRICE.output) / 1e6;
}

function tokens(events: readonly RunEvent[]) {
  const total = { input: 0, output: 0 };
  for (const { data } of events) {
    if (data.type !== "assistant_turn") continue;
    total.input += data.usage.inputTokens ?? 0;
    total.output += data.usage.outputTokens ?? 0;
  }
  return total;
}

const lastTurn = (events: readonly RunEvent[]) => [...events].reverse().find((e) => e.data.type === "assistant_turn");

describe.skipIf(!live)("section 16, live", () => {
  const db = live ? appDb() : (null as never);
  let leo: { tenantId: string; userId: string };

  const viewer = async () => {
    if (leo) return leo;
    const [org] = await db.$client`SELECT id FROM organization WHERE slug = 'kestrel'`;
    const [row] = await withTenantOn(db, org.id, (tx) =>
      tx.execute<{ tenant_id: string; id: string }>(
        sql`SELECT tenant_id, id FROM principals WHERE name = ${USER} AND kind = 'user'`,
      ),
    );
    leo = { tenantId: row.tenant_id, userId: row.id };
    return leo;
  };
  const state = async (runId: string) => (await withTenantOn(db, leo.tenantId, (tx) => loadState(tx, leo, runId)))!;

  it("routes four real messages", async () => {
    const messages = [
      { message: "What's the daily meal allowance on a work trip?", liveRun: false },
      { message: "Email Tom Whitfield the payment terms of KPC-2026-0142.", liveRun: false },
      { message: "Compare what the expenses policy v1 and v2 say about hotels.", liveRun: false },
      { message: "Actually, send it to Amara instead.", liveRun: true },
    ];
    const total = { input: 0, output: 0 };
    for (const input of messages) {
      const decision = await routeMessage(input, { model: chatModelFromEnv(), reasoningEffort: "low" });
      total.input += decision.usage?.inputTokens ?? 0;
      total.output += decision.usage?.outputTokens ?? 0;
      console.log(`[router] ${decision.route.padEnd(6)} ${JSON.stringify(input.message)}: ${decision.reason}`);
    }
    console.log(`[router] ${total.input} in, ${total.output} out, $${cost(total).toFixed(5)}`);
  }, 120_000);

  it("compares two policy versions with one sub-agent each", async () => {
    await viewer();
    const runId = crypto.randomUUID();
    await startRun(db, leo, {
      runId,
      message: {
        messageId: "live-proof",
        text:
          "Compare what the Travel and Expenses Policy (v1) and the Travel and Expenses Policy v2 say about hotels. " +
          "Hand each document to its own sub-agent.",
      },
    });
    const started = Date.now();
    const run = await start(agentRunWorkflow, [leo.tenantId, leo.userId, runId]);
    const outcome = await run.returnValue;
    const parent = await state(runId);
    const children = await withTenantOn(db, leo.tenantId, (tx) =>
      tx.execute<{ id: string; status: string; caps: unknown }>(
        sql`SELECT id, status, caps FROM runs WHERE parent_run_id = ${runId} ORDER BY created_at`,
      ),
    );
    const total = tokens(parent.events);
    for (const child of children) {
      const events = (await state(child.id)).events;
      const used = tokens(events);
      total.input += used.input;
      total.output += used.output;
      const tools = events.flatMap((e) =>
        e.data.type === "assistant_turn" ? e.data.toolCalls.map((c) => c.tool) : [],
      );
      console.log(
        `[orchestrator] child ${child.id} ${child.status} tools=${tools.join(",")} tokens=${JSON.stringify(used)}`,
      );
    }
    const final = lastTurn(parent.events);
    console.log(
      `[orchestrator] parent ${runId} ${JSON.stringify(outcome)} in ${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
    console.log(`[orchestrator] answer: ${final?.data.type === "assistant_turn" ? final.data.text : ""}`);
    console.log(`[orchestrator] ${total.input} in, ${total.output} out, $${cost(total).toFixed(5)}`);
    expect(children.length).toBe(2);
  }, 600_000);

  it("fires an automation once, as its owner", async () => {
    await viewer();
    const [automation] = await withTenantOn(db, leo.tenantId, (tx) =>
      tx.execute<{ id: string }>(sql`
        INSERT INTO automations (tenant_id, owner_id, name, prompt, trigger, cron, enabled)
        VALUES (${leo.tenantId}, ${leo.userId}, 'Live proof (lane E)',
                'In two sentences, what does the Travel and Expenses Policy v2 say about hotel stays?',
                'schedule', '0 9 * * 1', true)
        RETURNING id`),
    );
    const run = await start(automationWorkflow, [
      leo.tenantId,
      automation.id,
      `manual:${crypto.randomUUID()}`,
      new Date().toISOString(),
      null,
    ]);
    const outcome = await run.returnValue;
    await withTenantOn(db, leo.tenantId, (tx) =>
      tx.execute(sql`UPDATE automations SET enabled = false WHERE id = ${automation.id}`),
    );
    const first = outcome.runs[0];
    const runId = first.kind === "done" ? first.value.runId : null;
    const events = runId ? (await state(runId)).events : [];
    const used = tokens(events);
    const final = lastTurn(events);
    console.log(`[automation] ${automation.id} ${JSON.stringify(outcome)}`);
    console.log(`[automation] answer: ${final?.data.type === "assistant_turn" ? final.data.text : ""}`);
    console.log(`[automation] ${used.input} in, ${used.output} out, $${cost(used).toFixed(5)}`);
    expect(outcome.status).toBe("fired");
  }, 300_000);
});
