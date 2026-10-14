import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import postgres from "postgres";

import { createGraphClient } from "#learn/connectors/graph";
import { loadWorld } from "@/fixtures/world";

import { TOKEN_PREFIX } from "../../servers/fake-workspace/corpus";
import { localEnv } from "./env";
import { runGate } from "./gate";
import { checkAgent, checkApproval } from "./smoke-agent";
import { checkAnswer } from "./smoke-answer";
import { waitForApp } from "./smoke-ready";
import { checkRedteam } from "./smoke-redteam";
import { checkRetrieval } from "./smoke-retrieval";

export type CheckResult = { name: string; passed: boolean; detail: string | null; duration_s: number };
/** Resolves with an optional detail when the check passes; throws when it fails. */
export type Check = () => Promise<string | null>;
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Where the running stack answers, and how to reach it. */
export type SmokeTargets = {
  /** The app role's URL, which row-level security binds. */
  databaseUrl: string;
  /** The owner's, for check 1's probe table; the app role can't create one. Defaults to databaseUrl. */
  adminDatabaseUrl?: string;
  appUrl: string;
  workspaceUrl: string;
  /** The corpus fake-workspace serves; its manifest names the documents the checks look up. */
  corpusDir: string;
  /** How long the app's checks wait for a cold dev server (`waitForApp`); 90 s when unset. */
  readyTimeoutMs?: number;
  /** fake-workspace's `/_control` token, for counting sends. Defaults to the dev one. */
  workspaceControlToken?: string;
  fetch: Fetch;
};

export async function runCheck(name: string, check: Check): Promise<CheckResult> {
  const started = performance.now();
  let passed = true;
  let detail: string | null;
  try {
    detail = await check();
  } catch (error) {
    // A smoke check reports every failure, whatever threw it.
    passed = false;
    detail = error instanceof Error ? error.message || error.name : String(error);
  }
  return { name, passed, detail, duration_s: Math.round(performance.now() - started) / 1000 };
}

export function runChecks(checks: [string, Check][]): Promise<CheckResult[]> {
  return Promise.all(checks.map(([name, check]) => runCheck(name, check)));
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The stack `pnpm dev` and `pnpm fake-workspace` run: the environment, then `.env.local` (as
 * dotenv-cli reads it for them), then the dev defaults from docs/m0-contract.md.
 */
export function smokeTargets(root: string, env: NodeJS.ProcessEnv = process.env): SmokeTargets {
  const vars = localEnv(root, env);
  return {
    databaseUrl: vars.DATABASE_URL || "postgres://ac_app:ac_app@localhost:5432/ac",
    adminDatabaseUrl: vars.DATABASE_ADMIN_URL || "postgres://ac:ac@localhost:5432/ac",
    appUrl: vars.BETTER_AUTH_URL || "http://localhost:3000",
    workspaceUrl: vars.FAKE_WORKSPACE_URL || "http://localhost:8100",
    corpusDir: resolve(root, vars.AC_CORPUS_DIR || "fixtures/corpus/build"),
    workspaceControlToken: vars.FAKE_WORKSPACE_CONTROL_TOKEN || undefined,
    fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
  };
}

type Service = { url: string; start: string };

export async function send(fetch: Fetch, service: Service, path: string, init: RequestInit = {}): Promise<Response> {
  const url = path.startsWith("http") ? path : `${service.url}${path}`;
  try {
    return await fetch(url, init);
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    const hint = code === "ECONNREFUSED" ? `; is \`${service.start}\` running?` : "";
    throw new Error(`${init.method ?? "GET"} ${url} failed (${code ?? (error as Error).message})${hint}`);
  }
}

export async function readText(response: Response, what: string): Promise<string> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${what} answered ${response.status}: ${text.slice(0, 200).trim()}`);
  return text;
}

async function readJson<T>(response: Response, what: string): Promise<T> {
  return JSON.parse(await readText(response, what)) as T;
}

const EXTENSIONS = ["pg_search", "vector"];

/** 1. ParadeDB is healthy, has pg_search and vector, and answers a BM25 and a pgvector query. */
export async function checkParadeDb(databaseUrl: string): Promise<string> {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    let rows: { extname: string; extversion: string }[];
    try {
      rows = await sql`SELECT extname, extversion FROM pg_extension WHERE extname IN ${sql(EXTENSIONS)}`;
    } catch (error) {
      if ((error as { code?: string }).code !== "ECONNREFUSED") throw error;
      throw new Error(`nothing answers at ${new URL(databaseUrl).host}; \`pnpm ex up\` starts ParadeDB`);
    }
    const versions = new Map(rows.map((row) => [row.extname, row.extversion]));
    const missing = EXTENSIONS.filter((name) => !versions.has(name));
    if (missing.length > 0) throw new Error(`${missing.join(" and ")} missing; \`pnpm db:migrate\` creates them`);

    // A table in a transaction that's rolled back, so nothing is left behind. Not a temporary table:
    // pg_search 0.25.11 leaks buffer pins on those (hundreds of "resource was not closed" warnings).
    const tx = await sql.reserve();
    let bm25: number[];
    let nearest: number[];
    try {
      await tx`BEGIN`;
      await tx`CREATE TABLE ex_smoke_probe (id int PRIMARY KEY, body text NOT NULL, embedding vector(3) NOT NULL)`;
      await tx`INSERT INTO ex_smoke_probe VALUES
        (1, 'Contract KPC-2025-0099 renews in 2026', '[0,1,0]'),
        (2, 'Supplier terms for Kestrel Payouts', '[1,0,0]'),
        (3, 'The office lunch menu', '[0,0,1]')`;
      await tx`CREATE INDEX ex_smoke_probe_bm25 ON ex_smoke_probe USING bm25 (id, body) WITH (key_field = 'id')`;
      const matches = await tx<{ id: number }[]>`
        SELECT id FROM ex_smoke_probe WHERE body ||| 'supplier payouts' ORDER BY pdb.score(id) DESC`;
      const neighbours = await tx<{ id: number }[]>`
        SELECT id FROM ex_smoke_probe ORDER BY embedding <-> '[0.9,0.1,0]' LIMIT 1`;
      bm25 = matches.map((row) => row.id);
      nearest = neighbours.map((row) => row.id);
    } finally {
      await tx`ROLLBACK`;
      tx.release();
    }
    if (bm25.join() !== "2") throw new Error(`the BM25 query found rows [${bm25}], want [2]`);
    if (nearest.join() !== "2") throw new Error(`the nearest-neighbour query found rows [${nearest}], want [2]`);
    return `pg_search ${versions.get("pg_search")}, vector ${versions.get("vector")}; BM25 and nearest neighbour both found row 2`;
  } finally {
    await sql.end();
  }
}

type Viewer = { userId?: string; tenant?: { slug?: string } };

/** Signs in through better-auth's own endpoint, as the login page does. */
export async function signIn(target: SmokeTargets, email: string, password: string): Promise<Response> {
  return send(target.fetch, { url: target.appUrl, start: "pnpm dev" }, "/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: target.appUrl },
    body: JSON.stringify({ email, password }),
  });
}

export function sessionCookie(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
}

const SIGN_IN = [
  ["kestrel", "leo.martin"],
  ["harbour", "nina.osei"],
] as const;

/** 2. leo.martin signs in on :3000 and `/api/me` says kestrel; nina.osei gets harbour. */
export async function checkSignIn(target: SmokeTargets): Promise<string> {
  const world = loadWorld();
  const app = { url: target.appUrl, start: "pnpm dev" };
  const seen: string[] = [];
  for (const [tenant, username] of SIGN_IN) {
    const { email } = world.user(tenant, username);
    const response = await signIn(target, email, world.tenant(tenant).password);
    await readJson(response, `${username}'s sign-in`);
    const cookie = sessionCookie(response);
    const viewer = await readJson<Viewer>(await send(target.fetch, app, "/api/me", { headers: { cookie } }), "/api/me");
    const signOut = await send(target.fetch, app, "/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json", origin: target.appUrl, cookie },
      body: "{}",
    });
    await readJson(signOut, `${username}'s sign-out`);
    if (viewer.tenant?.slug !== tenant) {
      throw new Error(`${username}'s /api/me says tenant ${viewer.tenant?.slug ?? "none"}, want ${tenant}`);
    }
    const id = world.userId(tenant, username);
    if (viewer.userId !== id) throw new Error(`${username} has id ${viewer.userId}, not the world's ${id}`);
    seen.push(`${username} -> ${tenant}`);
  }
  return seen.join(", ");
}

/** 3. peter.hall is banned, so his sign-in is refused. */
export async function checkBannedUser(target: SmokeTargets): Promise<string> {
  const world = loadWorld();
  const { email, enabled } = world.user("kestrel", "peter.hall");
  if (enabled) throw new Error("world.yaml has peter.hall enabled; he is the banned user");
  const response = await signIn(target, email, world.tenant("kestrel").password);
  const body = (await response.json().catch(() => ({}))) as { code?: string };
  if (response.ok) throw new Error("peter.hall signed in; `pnpm db:seed` bans him");
  if (response.status !== 403 || body.code !== "BANNED_USER") {
    throw new Error(`peter.hall was refused with ${response.status} ${body.code ?? ""}, want 403 BANNED_USER`.trim());
  }
  if (sessionCookie(response)) throw new Error("peter.hall was refused but given a session cookie");
  return "peter.hall: 403 BANNED_USER";
}

type Manifest = { sites: Record<string, { items: { id: string; path: string; traps?: string[] }[] }> };
type Page<T> = { value: T[]; "@odata.nextLink"?: string };
type Permission = { roles: string[]; grantedToV2: { user?: { id: string }; group?: { id: string } } };

const EXEC = "/Kestrel/Exec";

/** 4. fake-workspace on :8100: the Heron memo's one grant, Harbour's 403, and /Kestrel/Exec's transitive members. */
export async function checkFakeWorkspace(target: SmokeTargets): Promise<string> {
  const world = loadWorld();
  const service = { url: target.workspaceUrl, start: "pnpm fake-workspace" };
  const get = (path: string, site: string) =>
    send(target.fetch, service, path, { headers: { authorization: `Bearer ${TOKEN_PREFIX}${site}` } });

  const health = await readJson<{ corpus_loaded?: boolean }>(await send(target.fetch, service, "/health"), "/health");
  if (!health.corpus_loaded) throw new Error("fake-workspace runs without its corpus; check AC_CORPUS_DIR");

  const manifest = JSON.parse(readFileSync(join(target.corpusDir, "manifest.json"), "utf8")) as Manifest;
  const leaks = manifest.sites.kestrel?.items.filter((item) => item.traps?.includes("acl-leak")) ?? [];
  if (leaks.length !== 1) throw new Error(`the manifest has ${leaks.length} acl-leak documents, want 1`);
  const [memo] = leaks;
  const permissions = await readJson<Page<Permission>>(
    await get(`/v1.0/sites/kestrel/drive/items/${memo.id}/permissions`, "kestrel"),
    `${memo.path}'s permissions`,
  );
  const exec = world.groupId("kestrel", EXEC);
  const grants = permissions.value.map(
    (p) => `${p.roles.join("+")} ${p.grantedToV2.group?.id ?? p.grantedToV2.user?.id}`,
  );
  if (grants.join() !== `write ${exec}`) {
    throw new Error(`${memo.path} has grants [${grants.join(", ")}], want only write to ${EXEC} (${exec})`);
  }

  const crossTenant = await get("/v1.0/sites/kestrel/drive/root", "harbour");
  if (crossTenant.status !== 403)
    throw new Error(`Harbour's token on Kestrel's site got ${crossTenant.status}, want 403`);

  const members = new Set<string>();
  for (let next: string | undefined = `/v1.0/sites/kestrel/groups/${exec}/transitiveMembers`; next;) {
    const page: Page<{ id: string }> = await readJson(await get(next, "kestrel"), `${EXEC}'s transitive members`);
    for (const member of page.value) members.add(member.id);
    next = page["@odata.nextLink"];
  }
  if (!members.has(world.userId("kestrel", "daniel.reyes"))) throw new Error(`${EXEC} doesn't reach daniel.reyes`);
  if (members.has(world.userId("kestrel", "leo.martin"))) throw new Error(`${EXEC} reaches leo.martin`);

  return `${memo.path}: write to ${EXEC} only; Harbour's token: 403; ${EXEC} reaches daniel.reyes, not leo.martin`;
}

type TenantDocument = { external_id: string; path: string; status: string; acl_version: string; chunks: number };

/**
 * 7. Ingestion: every file fake-workspace serves for each tenant is a `ready` document with chunks and a stamped
 * ACL, nothing else is live, and the Heron memo's `document_acl` holds /Kestrel/Exec only. It reads as the app
 * role, one tenant per transaction, as the app does.
 */
export async function checkIngestion(target: SmokeTargets): Promise<string> {
  await send(target.fetch, { url: target.workspaceUrl, start: "pnpm fake-workspace" }, "/health");
  const manifest = JSON.parse(readFileSync(join(target.corpusDir, "manifest.json"), "utf8")) as Manifest;
  const [memo] = manifest.sites.kestrel?.items.filter((item) => item.traps?.includes("acl-leak")) ?? [];
  if (!memo) throw new Error("the manifest has no acl-leak document");

  const sql = postgres(target.databaseUrl, { max: 1, connect_timeout: 5, onnotice: () => {} });
  const summary: string[] = [];
  try {
    for (const site of Object.keys(manifest.sites).sort()) {
      const files: string[] = [];
      const graph = createGraphClient({
        baseUrl: target.workspaceUrl,
        site,
        token: `${TOKEN_PREFIX}${site}`,
        fetch: target.fetch,
      });
      for await (const { item } of graph.crawl()) files.push(item.id);

      const [tenant] = await sql<{ id: string }[]>`SELECT id FROM organization WHERE slug = ${site}`;
      if (!tenant) throw new Error(`no ${site} organization; run \`pnpm db:seed\``);
      const { live, heron } = await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
        const live = await tx<TenantDocument[]>`
          SELECT d.external_id, d.path, d.status, d.acl_version,
            (SELECT count(*)::int FROM chunks c WHERE c.document_id = d.id AND c.document_version = d.version) AS chunks
          FROM documents d WHERE d.status <> 'deleted'`;
        const heron = await tx<{ name: string }[]>`
          SELECT p.name FROM documents d
          JOIN document_acl a ON a.document_id = d.id JOIN principals p ON p.id = a.principal_id
          WHERE d.external_id = ${memo.id} ORDER BY p.name`;
        return { live, heron };
      });

      const byId = new Map(live.map((row) => [row.external_id, row]));
      const missing = files.filter((id) => !byId.has(id));
      if (missing.length)
        throw new Error(`${site}: ${missing.length} of ${files.length} files have no document; is a sync done?`);
      const extra = live.filter((row) => !files.includes(row.external_id));
      if (extra.length)
        throw new Error(`${site}: ${extra.map((row) => row.path).join(", ")} live but gone from the drive`);
      const unready = live.filter((row) => row.status !== "ready");
      if (unready.length) {
        throw new Error(`${site}: not ready: ${unready.map((row) => `${row.path} (${row.status})`).join(", ")}`);
      }
      const empty = live.filter((row) => row.chunks === 0 || Number(row.acl_version) === 0);
      if (empty.length) throw new Error(`${site}: no chunks or no ACL: ${empty.map((row) => row.path).join(", ")}`);
      summary.push(`${site} ${live.length} ready (${live.reduce((sum, row) => sum + row.chunks, 0)} chunks)`);

      if (site === "kestrel") {
        const names = heron.map((row) => row.name);
        if (names.join() !== EXEC)
          throw new Error(`${memo.path}'s document_acl holds [${names.join(", ")}], want ${EXEC} only`);
      }
    }
  } finally {
    await sql.end();
  }
  return `${summary.join(", ")}; ${memo.path}'s ACL: ${EXEC} only`;
}

export type SpikeOptions = { sleepMs?: number; pollMs?: number; timeoutMs?: number };

const OPEN = ["pending", "running"];

/**
 * 5. The spike workflow starts, waits on its hook, resumes, sleeps, streams and completes, through
 * the real routes (src/routes/api/spike).
 */
export async function checkSpikeWorkflow(
  target: SmokeTargets,
  { sleepMs = 1000, pollMs = 200, timeoutMs = 60_000 }: SpikeOptions = {},
): Promise<string> {
  const app = { url: target.appUrl, start: "pnpm dev" };
  const deadline = Date.now() + timeoutMs;
  const post = (path: string, body: unknown) =>
    send(target.fetch, app, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const pause = () => new Promise((done) => setTimeout(done, pollMs));
  const timedOut = (what: string) => {
    if (Date.now() > deadline) throw new Error(`gave up after ${timeoutMs / 1000} s waiting for ${what}`);
  };

  const { runId, token } = await readJson<{ runId: string; token: string }>(
    await post("/api/spike", { sleepMs }),
    "POST /api/spike",
  );
  const status = async () =>
    (await readJson<{ status: string }>(await send(target.fetch, app, `/api/spike/${runId}`), "the run's status"))
      .status;

  // Read the stream while the run goes on: it ends when the run's last step closes it.
  const reading = new AbortController();
  const streamed = send(target.fetch, app, `/api/spike/${runId}/stream`, {
    signal: AbortSignal.any([reading.signal, AbortSignal.timeout(timeoutMs)]),
  }).then((response) => readText(response, "the run's stream"));
  streamed.catch(() => {}); // awaited below, unless the check fails first
  try {
    const note = `smoke-${runId.slice(-6)}`;
    const before = await status();
    if (!OPEN.includes(before)) throw new Error(`run ${runId} is ${before} before its hook was resumed`);

    // start() returns before the run registers its hook, so the first resumes can 404.
    let resumedAt: number;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      resumedAt = Date.now();
      const response = await post("/api/spike/resume", { token, note });
      if (response.status !== 404) {
        await readJson(response, "POST /api/spike/resume");
        break;
      }
      timedOut("the run's hook");
      await pause();
    }

    let after: string;
    while (OPEN.includes((after = await status()))) {
      timedOut("the run to complete");
      await pause();
    }
    const elapsed = Date.now() - resumedAt;
    if (after !== "completed") throw new Error(`run ${runId} ended ${after}`);
    if (elapsed < sleepMs) throw new Error(`run ${runId} completed ${elapsed} ms after the resume, inside its sleep`);

    const texts = (await streamed)
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { text: string }).text);
    if (texts.join() !== ["resumed", note, "done"].join()) {
      throw new Error(`the stream carried [${texts.join(", ")}], want [resumed, ${note}, done]`);
    }
    return `run ${runId}: resumed (attempt ${attempts}), slept ${sleepMs} ms, streamed 3 chunks, completed`;
  } finally {
    reading.abort();
  }
}

/** The steps the gate must have checked: `_smoke.2` runs its tests in the `workflows` project. */
const GATE_STEPS = ["_smoke.1", "_smoke.2"];

/** 6. `pnpm ex gate` passes: every graded step fails on its problem code and passes on its solution. */
export async function checkGate(root: string): Promise<string> {
  const results = await runGate(root);
  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) throw new Error(failed.map((r) => `${r.step}: ${r.reasons.join("; ")}`).join("; "));
  const missing = GATE_STEPS.filter((step) => !results.some((result) => result.step === step));
  if (missing.length > 0) throw new Error(`the gate didn't check ${missing.join(" and ")}`);
  return `passed ${results.map((result) => result.step).join(", ")}`;
}

/**
 * The checks `pnpm ex smoke` runs, at once. The ones that talk to the dev server first wait for it to be ready
 * (`waitForApp`): a cold server still compiling, or another app on the port, fails them with the reason.
 */
export function smokeChecks(
  root: string,
  target: SmokeTargets,
  ready: () => Promise<string> = () => waitForApp(root, target),
): [string, Check][] {
  let waiting: Promise<string> | undefined;
  const app =
    (check: () => Promise<string | null>): Check =>
    async () => {
      waiting ??= ready();
      try {
        await waiting;
      } catch (error) {
        throw new Error(`the app isn't ready: ${(error as Error).message}`);
      }
      return check();
    };
  return [
    ["paradedb extensions and queries", () => checkParadeDb(target.adminDatabaseUrl ?? target.databaseUrl)],
    ["sign in and /api/me", app(() => checkSignIn(target))],
    ["banned user refused", app(() => checkBannedUser(target))],
    ["fake-workspace sharing and directory", () => checkFakeWorkspace(target)],
    ["spike workflow", app(() => checkSpikeWorkflow(target))],
    ["ex gate", () => checkGate(root)],
    ["ingestion", () => checkIngestion(target)],
    ["retrieval", () => checkRetrieval(target)],
    ["answer", app(() => checkAnswer(target))],
    ["agent", app(() => checkAgent(target))],
    ["approval", app(() => checkApproval(target))],
    ["red-team", () => checkRedteam(target, target.workspaceControlToken)],
  ];
}
