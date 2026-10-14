/**
 * `pnpm redteam`: runs the red-team scenarios (`#learn/redteam/scenarios`) live, on gpt-6-luna, against the dev
 * database and fake-workspace on :8100, and writes a dated report to fixtures/redteam/reports/.
 *
 *   pnpm redteam                 every scenario, then the report
 *   pnpm redteam --only a,b      just these; prints, writes no report
 *
 * Each run is in-process (the in-memory runner in `#learn/agent/loop-testing`), as the scenario's user, with the
 * app's tools, guard and guardrails. It approves every write blindly. It never resets fake-workspace: it counts
 * mail and shares by its own idempotency keys (`agent:<runId>:...`), and deletes any note a run managed to store.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { sql } from "drizzle-orm";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentTool } from "#learn/agent/types";
import type { Viewer } from "#learn/retrieve/types";

import { rememberTool } from "#learn/agent/memory";
import { aiSdkChatModel } from "#learn/model/ai-sdk";
import { CHAT_MODEL, CHAT_REASONING_EFFORT } from "#learn/model/config";
import { costUsd, report, runScenario, type ScenarioResult } from "#learn/redteam/run";
import { type Effects, SCENARIOS } from "#learn/redteam/scenarios";
import { appDb, closeDb } from "@/db/pool";
import { withTenant } from "@/db/tenant";
import { agentGuard, agentTools } from "@/lib/agent-tools";
import { workspaceUrl } from "@/workflows/sync-common";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPORTS = join(ROOT, "fixtures/redteam/reports");
const CONTROL = { "x-workspace-control": process.env.FAKE_WORKSPACE_CONTROL_TOKEN || "dev-workspace-control" };

async function waitForWorkspace(base: string) {
  for (let i = 0; i < 60; i++) {
    const up = await fetch(`${base}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) return;
    if (i === 0) console.log(`waiting for fake-workspace on ${base}...`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`fake-workspace isn't up on ${base}`);
}

async function viewerFor(username: string): Promise<Viewer> {
  const [org] = await appDb().execute<{ id: string }>(sql`SELECT id FROM organization WHERE slug = 'kestrel'`);
  if (!org) throw new Error("no kestrel tenant: run pnpm ex up");
  const [user] = await withTenant(org.id, (tx) =>
    tx.execute<{ id: string }>(sql`SELECT id FROM principals WHERE kind = 'user' AND name = ${username}`),
  );
  if (!user) throw new Error(`no user ${username} in kestrel's directory`);
  return { tenantId: org.id, userId: user.id };
}

async function listed<T>(base: string, path: string): Promise<T[]> {
  const response = await fetch(`${base}${path}`, { headers: CONTROL });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return ((await response.json()) as { value: T[] }).value;
}

function effectsReader(base: string, viewer: Viewer) {
  return async (runId: string): Promise<Effects> => {
    const ours = (key: string | null) => key?.startsWith(`agent:${runId}:`) ?? false;
    type Keyed = { idempotencyKey: string | null };
    const mails = (await listed<Effects["mails"][number] & Keyed>(base, "/_control/mail")).filter((m) =>
      ours(m.idempotencyKey),
    );
    const invites = (await listed<Effects["invites"][number] & Keyed>(base, "/_control/invites")).filter((i) =>
      ours(i.idempotencyKey),
    );
    const notes = await withTenant(viewer.tenantId, (tx) =>
      tx.execute<{ text: string }>(sql`DELETE FROM memory_notes WHERE source_run_id = ${runId} RETURNING text`),
    );
    return { mails, invites, notes: notes.map((n) => n.text) };
  };
}

async function main() {
  const onlyIndex = process.argv.indexOf("--only");
  const only = onlyIndex >= 0 ? new Set(process.argv[onlyIndex + 1]?.split(",")) : null;
  const scenarios = SCENARIOS.filter((s) => !only || only.has(s.id));
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY must be set: the red-team runs live");

  const base = workspaceUrl().replace(/\/$/, "");
  await waitForWorkspace(base);
  const model = aiSdkChatModel(createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(CHAT_MODEL));

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const viewer = await viewerFor(scenario.user);
    const started = Date.now();
    const result = await runScenario(scenario, {
      model,
      reasoningEffort: CHAT_REASONING_EFFORT,
      tools: [...agentTools(), rememberTool({ withTenant }) as AgentTool],
      viewer,
      guard: agentGuard(viewer),
      effects: effectsReader(base, viewer),
    });
    results.push(result);
    console.log(
      `${result.passed ? "pass" : "FAIL"}  ${scenario.id}  (${result.modelTurns} turns, ` +
        `${((Date.now() - started) / 1000).toFixed(0)} s, $${costUsd(result).toFixed(4)})` +
        (result.violation ? `: ${result.violation}` : ""),
    );
    for (const write of result.writes) console.log(`      ${write.tool}: ${write.outcome}`);
  }

  if (!only) {
    const date = new Date().toISOString().slice(0, 10);
    mkdirSync(REPORTS, { recursive: true });
    const path = join(REPORTS, `${date}.md`);
    writeFileSync(path, report(date, `live, ${CHAT_MODEL} at ${CHAT_REASONING_EFFORT} effort`, results));
    console.log(`report: ${path}`);
  }
  return results.every((r) => r.passed) ? 0 : 1;
}

try {
  process.exitCode = await main();
} finally {
  await closeDb(process.env.DATABASE_URL!);
}
