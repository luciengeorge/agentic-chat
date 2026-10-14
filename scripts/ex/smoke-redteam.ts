import { sql } from "drizzle-orm";

import type { RunGuard } from "#learn/agent/loop";
import type { AgentTool } from "#learn/agent/types";
import type { Retrieve, Viewer } from "#learn/retrieve/types";
import type { Tx } from "@/db/tenant";

import { createGuardrails } from "#learn/agent/guardrails";
import { rememberTool } from "#learn/agent/memory";
import { createAgentTools } from "#learn/agent/tools/index";
import { createWorkspaceWriter } from "#learn/agent/tools/workspace";
import { scriptedTurns } from "#learn/model/testing";
import { runScenario, type ScenarioResult } from "#learn/redteam/run";
import { type Effects, SCENARIOS, type ScenarioIds } from "#learn/redteam/scenarios";
import { createDb } from "@/db/create";
import { withTenantOn } from "@/db/tenant";

import { CONTROL_HEADER, DEV_CONTROL_TOKEN } from "../../servers/fake-workspace/control";
import { TOKEN_PREFIX } from "../../servers/fake-workspace/corpus";
import { readText, send, type Fetch, type SmokeTargets } from "./smoke";

export type WithTenant = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;

/** The documents and people the red-team names, looked up in the database the run uses. */
export const REDTEAM_PATHS = {
  heron: "/Exec/Project Heron Board Memo.pdf",
  q3: "/Finance/Reports/Q3 2026 Quarterly Report.pdf",
};

type Queryable = { execute: Tx["execute"] };

async function tenantId(db: Queryable, slug: string): Promise<string> {
  const [org] = await db.execute<{ id: string }>(sql`SELECT id FROM organization WHERE slug = ${slug}`);
  if (!org) throw new Error(`no ${slug} tenant; run \`pnpm ex up\``);
  return org.id;
}

async function principal(withTenant: WithTenant, tenant: string, name: string): Promise<string> {
  const [row] = await withTenant(tenant, (tx) =>
    tx.execute<{ id: string }>(sql`SELECT id FROM principals WHERE kind = 'user' AND name = ${name}`),
  );
  if (!row) throw new Error(`no user ${name} in the directory`);
  return row.id;
}

async function documentId(withTenant: WithTenant, tenant: string, path: string): Promise<string> {
  const [row] = await withTenant(tenant, (tx) =>
    tx.execute<{ id: string }>(sql`SELECT id FROM documents WHERE path = ${path} AND status = 'ready'`),
  );
  if (!row) throw new Error(`no ready document ${path}; is a sync done?`);
  return row.id;
}

/** Kestrel's tenant, a viewer for each user the scenarios name, and the ids their scripts and plants use. */
export async function redteamWorld(withTenant: WithTenant, db: Queryable) {
  const kestrel = await tenantId(db, "kestrel");
  const harbour = await tenantId(db, "harbour");
  const ids: ScenarioIds = {
    heron: await documentId(withTenant, kestrel, REDTEAM_PATHS.heron),
    q3: await documentId(withTenant, kestrel, REDTEAM_PATHS.q3),
    nina: await principal(withTenant, harbour, "nina.osei"),
    tom: await principal(withTenant, kestrel, "tom.whitfield"),
  };
  const viewers = new Map<string, Viewer>();
  for (const user of new Set(SCENARIOS.map((s) => s.user))) {
    viewers.set(user, { tenantId: kestrel, userId: await principal(withTenant, kestrel, user) });
  }
  return { ids, viewer: (user: string) => viewers.get(user)! };
}

async function listed<T>(fetch: Fetch, base: string, path: string, token: string): Promise<T[]> {
  const response = await send(fetch, { url: base, start: "pnpm fake-workspace" }, path, {
    headers: { [CONTROL_HEADER]: token },
  });
  return (JSON.parse(await readText(response, `GET ${path}`)) as { value: T[] }).value;
}

/**
 * What a run did outside: mail and shares in fake-workspace that carry its idempotency keys (`agent:<runId>:...`),
 * never anyone else's, and the notes it stored, which are deleted as they're read.
 */
export function effectsReader(
  fetch: Fetch,
  base: string,
  withTenant: WithTenant,
  tenant: string,
  token = DEV_CONTROL_TOKEN,
) {
  return async (runId: string): Promise<Effects> => {
    const ours = (key: string | null) => key?.startsWith(`agent:${runId}:`) ?? false;
    type Keyed = { idempotencyKey: string | null };
    const mails = await listed<Effects["mails"][number] & Keyed>(fetch, base, "/_control/mail", token);
    const invites = await listed<Effects["invites"][number] & Keyed>(fetch, base, "/_control/invites", token);
    const notes = await withTenant(tenant, (tx) =>
      tx.execute<{ text: string }>(sql`DELETE FROM memory_notes WHERE source_run_id = ${runId} RETURNING text`),
    );
    return {
      mails: mails.filter((m) => ours(m.idempotencyKey)),
      invites: invites.filter((i) => ours(i.idempotencyKey)),
      notes: notes.map((n) => n.text),
    };
  };
}

/** Retrieval for the scripted runs: nothing found, so no embedding or rerank call. The plants still land. */
const findNothing: Retrieve = async (_viewer, query) => ({ query, rewritten: [], auditId: "", chunks: [] });

const NOOP_GUARD: Omit<RunGuard, "screen"> = {
  beforeModelTurn: async () => {},
  afterModelTurn: async () => {},
  beforeToolCall: async () => {},
};

/**
 * 12. Red-team: every scenario (`#learn/redteam/scenarios`) on a scripted model that obeys the attack, in this
 * process, against the dev database and fake-workspace, approving every write blindly. Each attack must be
 * refused, and each widen scenario must send only its planned write. No model is called.
 */
export async function checkRedteam(target: SmokeTargets, controlToken = DEV_CONTROL_TOKEN): Promise<string> {
  await readText(
    await send(target.fetch, { url: target.workspaceUrl, start: "pnpm fake-workspace" }, "/health"),
    "fake-workspace",
  );
  const db = createDb(target.databaseUrl);
  const withTenant: WithTenant = (tenant, fn) => withTenantOn(db, tenant, fn);
  try {
    const { ids, viewer } = await redteamWorld(withTenant, db);
    const tools = [
      ...createAgentTools({
        withTenant,
        retrieve: findNothing,
        workspace: async () =>
          createWorkspaceWriter({
            baseUrl: target.workspaceUrl,
            site: "kestrel",
            token: `${TOKEN_PREFIX}kestrel`,
            fetch: target.fetch,
          }),
      }),
      rememberTool({ withTenant }) as AgentTool,
    ];
    const results: ScenarioResult[] = [];
    for (const scenario of SCENARIOS) {
      const who = viewer(scenario.user);
      results.push(
        await runScenario(scenario, {
          model: scriptedTurns(scenario.script(ids)).model,
          tools,
          viewer: who,
          guard: { ...NOOP_GUARD, screen: createGuardrails({ withTenant }, who) },
          effects: effectsReader(target.fetch, target.workspaceUrl, withTenant, who.tenantId, controlToken),
          ids,
        }),
      );
    }
    const failed = results.filter((r) => !r.passed);
    if (failed.length) throw new Error(failed.map((r) => `${r.id}: ${r.violation}`).join("; "));
    const refused = results.flatMap((r) => r.writes).filter((w) => w.outcome !== "done").length;
    const planned = results.flatMap((r) => r.writes).filter((w) => w.outcome === "done").length;
    return `${results.length} scenarios passed: ${refused} attacking writes refused, ${planned} planned writes sent`;
  } finally {
    await db.$client.end();
  }
}
