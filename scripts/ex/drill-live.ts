/**
 * The running stack as `ex drill` sees it: ParadeDB (as its owner for a drill's own rows, as the app role for the
 * app's decisions), fake-workspace, and the app's own code on disk, imported when a probe needs it so it's the code
 * the learner just changed. Every URL comes from `.env.local`, as the dev server's do.
 */
import postgres from "postgres";

import type { GraphClient } from "@/core/connectors/graph";
import type { Action, Need, Probe } from "@/core/drills/types";
import type { Tx } from "@/db/tenant";

import type { Live, ProbeResult } from "./drill";

import { ExError } from "./errors";

export interface LiveOptions {
  env: NodeJS.ProcessEnv;
  /** fake-workspace's fetch: its health, control API and Graph routes. */
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  /** Tests stand in for the app's reranker or scheduler; by default the code on disk runs. */
  reranker?: () => Promise<Reranker>;
  nextAfter?: () => Promise<(cron: string, after: Date) => Date>;
}

/** A module the sealed fault names: the specifier isn't in this file, so reading it doesn't say which. */
const load = <T>(specifier: string): Promise<T> => import(/* @vite-ignore */ specifier) as Promise<T>;

type Reranker = { rerank(query: string, documents: string[], topN: number): Promise<unknown> };
type SyncModule = {
  fetchDirectory(graph: GraphClient): Promise<unknown>;
  applyDirectory(tx: Tx, tenantId: string, snapshot: never, now: Date): Promise<unknown>;
};
type RerankerModule = { rerankerFromEnv(env: NodeJS.ProcessEnv): Reranker };
type EmbedderModule = { embedderFromEnv(env: NodeJS.ProcessEnv): { version: string } };
type CronModule = { parseCron(text: string): never; nextAfter(cron: never, after: Date): Date };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** `HH:MM` on the machine's clock, `days` from today's date, as an instant. */
export function localInstant(now: Date, time: string, days: number): Date {
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hours, minutes);
}

const hhmm = (date: Date) => date.toISOString().slice(11, 16);

/** Whether the machine's clock is UTC all year: a schedule bug that mixes local and UTC can't show on it. */
export function clockOnUtc(year: number): boolean {
  return [0, 6].every((month) => new Date(year, month, 1).getTimezoneOffset() === 0);
}

/** Problems with the next `days` fires of a schedule that should fire at `utc` once a day. */
export function scheduleProblems(next: (after: Date) => Date, from: Date, utc: string, days: number): string[] {
  const problems: string[] = [];
  let previous: Date | null = null;
  let t = from;
  for (let i = 0; i < days && problems.length < 3; i++) {
    t = next(t);
    if (hhmm(t) !== utc) problems.push(`it fires at ${hhmm(t)} UTC on ${t.toISOString().slice(0, 10)}`);
    else if (previous && t.getTime() - previous.getTime() !== DAY) {
      problems.push(`it fires twice, or skips a day, around ${t.toISOString().slice(0, 10)}`);
    }
    previous = t;
  }
  return problems;
}

export function createLive(options: LiveOptions): Live {
  const { env } = options;
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const ownerUrl = env.DATABASE_ADMIN_URL || "postgres://ac:ac@localhost:5432/ac";
  const appUrl = env.DATABASE_URL || "postgres://ac_app:ac_app@localhost:5432/ac";
  const workspace = (env.FAKE_WORKSPACE_URL || "http://localhost:8100").replace(/\/$/, "");
  const controlToken = env.FAKE_WORKSPACE_CONTROL_TOKEN || "dev-workspace-control";

  let owner: postgres.Sql | null = null;
  const sql = () => (owner ??= postgres(ownerUrl, { max: 1, connect_timeout: 5, onnotice: () => {} }));
  let app: Promise<{ db: import("@/db/create").Db }> | null = null;
  const appDb = () =>
    (app ??= import("@/db/create").then(({ createDb }) => ({ db: createDb(appUrl) }))).then((loaded) => loaded.db);
  const world = async () => (await import("@/fixtures/world")).loadWorld();

  async function tenantId(slug: string): Promise<string> {
    const [row] = await sql()<{ id: string }[]>`SELECT id FROM organization WHERE slug = ${slug}`;
    if (!row) throw new ExError(`there's no tenant ${slug} in the database`, "`pnpm ex up` seeds it");
    return row.id;
  }

  async function inTenant<T>(site: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const { withTenantOn } = await import("@/core/acl/tenant");
    return withTenantOn(await appDb(), await tenantId(site), fn);
  }

  async function control(method: "POST" | "DELETE", path: string, body?: unknown): Promise<Response> {
    return fetch(`${workspace}/_control${path}`, {
      method,
      headers: { "x-workspace-control": controlToken, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function value(name: string): Promise<string> {
    const [kind, ...args] = name.split(/\s+/);
    switch (kind) {
      case "tenant":
        return tenantId(args[0]!);
      case "user":
        return (await world()).userId(args[0]!, args[1]!);
      case "group":
        return (await world()).groupId(args[0]!, args.slice(1).join(" "));
      case "embedder":
        return (await load<EmbedderModule>(args[0]!)).embedderFromEnv(env).version;
      case "local":
        return localInstant(now(), args[0]!, Number(args[1] ?? 0)).toISOString();
      case "local-utc":
        return `${hhmm(localInstant(now(), args[0]!, Number(args[1] ?? 0)))} UTC`;
      default:
        throw new Error(`unknown drill variable {{${name}}}`);
    }
  }

  async function preflight(need: Need): Promise<void> {
    if (need === "database") {
      try {
        await sql()`SELECT 1`;
      } catch (error) {
        throw new ExError(
          `ParadeDB isn't answering at ${new URL(ownerUrl).host}`,
          `${(error as Error).message}; \`pnpm ex up\` starts it`,
        );
      }
    } else if (need === "workspace") {
      const health = await fetch(`${workspace}/health`).then(
        async (response) => (response.ok ? ((await response.json()) as { corpus_loaded?: boolean }) : null),
        () => null,
      );
      if (!health)
        throw new ExError(`fake-workspace isn't answering at ${workspace}`, "`pnpm fake-workspace` starts it");
      if (!health.corpus_loaded) throw new ExError("fake-workspace has no corpus loaded", "its log says why");
    } else if (need === "cohere") {
      if (!env.COHERE_API_KEY) {
        throw new ExError("this drill needs the real reranker, and COHERE_API_KEY isn't set", "set it in .env.local");
      }
      if (env.MODEL_PROVIDER === "local") {
        throw new ExError(
          "this drill needs the hosted reranker, and MODEL_PROVIDER is local",
          "unset it in .env.local",
        );
      }
    } else if (clockOnUtc(now().getFullYear())) {
      throw new ExError(
        "this drill needs a clock that isn't on UTC, and this machine's is",
        "run `pnpm dev` and `pnpm ex drill` with a zone set, say `TZ=Europe/Paris`",
      );
    }
  }

  async function act(action: Action): Promise<void> {
    if (action.kind === "sql") {
      await sql().unsafe(action.text);
    } else if (action.kind === "membership") {
      const w = await world();
      const group = w.groupId(action.site, action.group);
      const user = w.userId(action.site, action.user);
      const base = `/sites/${action.site}/groups/${group}/members`;
      const response = action.member
        ? await control("POST", base, { member_id: user })
        : await control("DELETE", `${base}/${user}`);
      // Already as wanted: 409 when adding a member, 404 when removing someone who isn't one.
      if (!response.ok && response.status !== (action.member ? 409 : 404)) {
        throw new ExError(`fake-workspace refused a membership change: ${response.status}`, await response.text());
      }
    } else {
      const [{ fetchDirectory, applyDirectory }, { createGraphClient }] = await Promise.all([
        load<SyncModule>(action.module),
        import("@/core/connectors/graph"),
      ]);
      const token = env[`WORKSPACE_TOKEN_${action.site.toUpperCase()}`] || `dev-workspace-${action.site}`;
      const graph = createGraphClient({ baseUrl: workspace, site: action.site, token, fetch, maxRetries: 3 });
      const snapshot = await fetchDirectory(graph);
      const id = await tenantId(action.site);
      await inTenant(action.site, (tx) => applyDirectory(tx, id, snapshot as never, now()));
    }
  }

  async function probe(probe: Probe): Promise<ProbeResult> {
    if (probe.kind === "sql-none") {
      const rows = await sql().unsafe(probe.text);
      return rows.length === 0
        ? { ok: true, detail: "" }
        : { ok: false, detail: `${probe.explain} (${rows.length} found)` };
    }
    if (probe.kind === "can-read") {
      const { canRead } = await import("@/core/retrieve/acl");
      const userId = (await world()).userId(probe.site, probe.user);
      const [document] = await sql()<{ id: string }[]>`
        SELECT id FROM documents WHERE tenant_id = ${await tenantId(probe.site)} AND path = ${probe.path}`;
      if (!document) return { ok: false, detail: `${probe.explain} (there's no document at ${probe.path})` };
      const reads = await inTenant(probe.site, (tx) => canRead(tx, userId, document.id));
      return reads === probe.expect ? { ok: true, detail: "" } : { ok: false, detail: probe.explain };
    }
    if (probe.kind === "reranker-answers") {
      const reranker = options.reranker
        ? await options.reranker()
        : (await load<RerankerModule>(probe.module)).rerankerFromEnv(env);
      try {
        await reranker.rerank(
          "London hotel limit",
          ["The London hotel limit is £200 a night.", "Meals are £40 a day."],
          1,
        );
        return { ok: true, detail: "" };
      } catch (error) {
        return { ok: false, detail: `${probe.explain}: ${(error as Error).message.split("\n")[0]}` };
      }
    }
    const nextAfter = options.nextAfter
      ? await options.nextAfter()
      : await load<CronModule>(probe.module).then(
          ({ nextAfter: next, parseCron }) =>
            (cron: string, after: Date) =>
              next(parseCron(cron), after),
        );
    const problems = scheduleProblems((after) => nextAfter(probe.cron, after), now(), probe.utc, probe.days);
    return problems.length === 0
      ? { ok: true, detail: "" }
      : { ok: false, detail: `${probe.explain}: ${problems.join("; ")}` };
  }

  return {
    async preflight(needs) {
      for (const need of needs) await preflight(need);
    },
    async resolve(names, vars) {
      for (const name of names) if (vars[name] === undefined) vars[name] = await value(name);
    },
    async count(text) {
      return (await sql().unsafe(text)).length;
    },
    act,
    probe,
    async close() {
      await owner?.end();
      if (app) await (await app).db.$client.end();
    },
  };
}
