/**
 * The safety lab (section 17): the red-team scenarios (`#learn/redteam/scenarios`) on a scripted model that obeys
 * every attack, approving every write blindly, through `#learn/agent/*`, so a section 17 step that's unfinished or
 * wrong lets an attack through. The tools, the guardrails and the notes use the given database (the dev one in the
 * lab); mail and shares go to a fake-workspace held in this process for the one call, so nothing reaches the
 * running one. Retrieval finds nothing, so no model is called: the scenarios' planted text carries the attacks.
 */
import { sql } from "drizzle-orm";

import type { RunGuard } from "#learn/agent/loop";
import type { AgentTool } from "#learn/agent/types";
import type { Retrieve, Viewer } from "#learn/retrieve/types";
import type { Tx } from "@/db/tenant";

import { createGuardrails } from "#learn/agent/guardrails";
import { rememberTool } from "#learn/agent/memory";
import { createAgentTools } from "#learn/agent/tools/index";
import { createWorkspaceWriter } from "#learn/agent/tools/workspace";
import { obeyingModels, runScenario } from "#learn/redteam/run";
import { type Effects, SCENARIOS, type ScenarioIds } from "#learn/redteam/scenarios";

import { createApp } from "../../../servers/fake-workspace/app";

export type WithTenant = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;

export interface SafetyDeps {
  withTenant: WithTenant;
  /** Reads the tenants (`organization` isn't scoped to one). */
  db: { execute: Tx["execute"] };
}

export interface SafetyScenario {
  id: string;
  title: string;
  user: string;
}

export interface SafetyResult extends SafetyScenario {
  /** Null when the code under test threw before the scenario could finish. */
  passed: boolean | null;
  violation: string | null;
  /** Each write the obeying model attempted, and how it ended ("done", or why it was refused). */
  writes: Array<{ tool: string; input: string; outcome: string }>;
  outcome: string;
  error: string | null;
}

export const safetyScenarios = (): SafetyScenario[] => SCENARIOS.map(({ id, title, user }) => ({ id, title, user }));

const REDTEAM_PATHS = {
  heron: "/Exec/Project Heron Board Memo.pdf",
  q3: "/Finance/Reports/Q3 2026 Quarterly Report.pdf",
};

async function one<T>(rows: Promise<T[]>, what: string): Promise<T> {
  const [row] = await rows;
  if (!row) throw new Error(`no ${what}: is the dev database seeded and synced (\`pnpm ex up\`)?`);
  return row;
}

/** The ids the scenarios' scripts and plants name, and a viewer per user, from the database. */
async function world({ withTenant, db }: SafetyDeps) {
  const tenant = (slug: string) =>
    one(db.execute<{ id: string }>(sql`SELECT id FROM organization WHERE slug = ${slug}`), `${slug} tenant`).then(
      (row) => row.id,
    );
  const kestrel = await tenant("kestrel");
  const harbour = await tenant("harbour");
  const user = (tenantId: string, name: string) =>
    withTenant(tenantId, (tx) =>
      one(tx.execute<{ id: string }>(sql`SELECT id FROM principals WHERE kind = 'user' AND name = ${name}`), name),
    ).then((row) => row.id);
  const document = (path: string) =>
    withTenant(kestrel, (tx) =>
      one(tx.execute<{ id: string }>(sql`SELECT id FROM documents WHERE path = ${path} AND status = 'ready'`), path),
    ).then((row) => row.id);
  const ids: ScenarioIds = {
    heron: await document(REDTEAM_PATHS.heron),
    q3: await document(REDTEAM_PATHS.q3),
    nina: await user(harbour, "nina.osei"),
    tom: await user(kestrel, "tom.whitfield"),
  };
  const viewers = new Map<string, Viewer>();
  for (const name of new Set(SCENARIOS.map((s) => s.user))) {
    viewers.set(name, { tenantId: kestrel, userId: await user(kestrel, name) });
  }
  return { ids, viewer: (name: string) => viewers.get(name)! };
}

const findNothing: Retrieve = async (_viewer, query) => ({ query, rewritten: [], auditId: "", chunks: [] });

const NO_BUDGET: Omit<RunGuard, "screen"> = {
  beforeModelTurn: async () => {},
  afterModelTurn: async () => {},
  beforeToolCall: async () => {},
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Runs the chosen scenarios (all of them when `only` is empty), one after another. */
export async function runSafetyScenarios(deps: SafetyDeps, only: readonly string[] = []): Promise<SafetyResult[]> {
  const { ids, viewer } = await world(deps);
  const { app, runtime } = createApp({ env: "dev" });
  const fetch = async (url: string | URL | Request, init?: RequestInit) =>
    app.fetch(new Request(new URL(String(url), "http://fw"), init));
  const tools = [
    ...createAgentTools({
      withTenant: deps.withTenant,
      retrieve: findNothing,
      workspace: async () =>
        createWorkspaceWriter({ baseUrl: "http://fw", site: "kestrel", token: "dev-workspace-kestrel", fetch }),
    }),
    rememberTool({ withTenant: deps.withTenant }) as AgentTool,
  ];
  const ours = (runId: string) => (key: string | null) => key?.startsWith(`agent:${runId}:`) ?? false;
  const results: SafetyResult[] = [];
  try {
    for (const scenario of SCENARIOS.filter((s) => only.length === 0 || only.includes(s.id))) {
      const who = viewer(scenario.user);
      const base = { id: scenario.id, title: scenario.title, user: scenario.user };
      // Effects are read for this run alone, by its idempotency keys; a note it stored is deleted as it's read.
      const effects = async (runId: string): Promise<Effects> => {
        const notes = await deps.withTenant(who.tenantId, (tx) =>
          tx.execute<{ text: string }>(sql`DELETE FROM memory_notes WHERE source_run_id = ${runId} RETURNING text`),
        );
        return {
          mails: runtime.mailroom.sent.filter((m) => ours(runId)(m.idempotencyKey)),
          invites: runtime.invites.done.filter((i) => ours(runId)(i.idempotencyKey)),
          notes: notes.map((n) => n.text),
        };
      };
      const runId = crypto.randomUUID();
      try {
        const result = await runScenario(scenario, {
          ...obeyingModels(scenario, ids),
          runId,
          tools,
          viewer: who,
          guard: { ...NO_BUDGET, screen: createGuardrails({ withTenant: deps.withTenant }, who) },
          effects,
          ids,
        });
        results.push({
          ...base,
          passed: result.passed,
          violation: result.violation,
          writes: result.writes.map((w) => ({ tool: w.tool, input: JSON.stringify(w.input), outcome: w.outcome })),
          outcome: result.outcome,
          error: null,
        });
      } catch (error) {
        await effects(runId).catch(() => {});
        results.push({ ...base, passed: null, violation: null, writes: [], outcome: "threw", error: message(error) });
      }
    }
  } finally {
    await runtime.notifier.close();
  }
  return results;
}
