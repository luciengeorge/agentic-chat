/**
 * The kill proof (section 15, live): a run survives a dev server killed mid-tool-call, and its side effect happens
 * once. As leo.martin, on the Workflow runner and a real model:
 *
 *   1. start a run that sends one mail, and approve the send once it asks;
 *   2. kill the dev server (SIGKILL) while `send_mail` is in flight, held there by a fake-workspace latency fault;
 *   3. start the dev server again: the run resumes and finishes `succeeded`, and fake-workspace holds exactly one
 *      mail with the run's idempotency key.
 *
 * Then a second check: a run left waiting on its approval across a restart resumes when the approval is decided
 * after it.
 *
 * Needs ParadeDB, fake-workspace on :8100 and OPENAI_API_KEY. It starts and kills its own dev server on :3000, so
 * stop yours first; it leaves none running. `pnpm agent:kill-proof`.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

import { loadWorld } from "@/fixtures/world";

import { CONTROL_HEADER, DEV_CONTROL_TOKEN } from "../servers/fake-workspace/control";
import { localEnv } from "./ex/env";
import { sessionCookie, signIn, smokeTargets } from "./ex/smoke";

const ROOT = join(import.meta.dirname, "..");
const LOG_DIR = join(ROOT, "node_modules/.cache/agent-kill-proof");
const SEND_LATENCY_MS = 15_000;

const env = localEnv(ROOT);
const target = smokeTargets(ROOT);
const world = loadWorld();
const db = postgres(target.adminDatabaseUrl!, { max: 2, onnotice: () => {} });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString().slice(11, 23);
const say = (line: string) => console.log(`${stamp()} ${line}`);

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

function listeningPids(port: number): number[] {
  try {
    return execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

let server: ChildProcess | null = null;
let starts = 0;

/** `pnpm dev` in its own process group, so a kill takes the whole tree; then waits until it's warm. */
async function startDevServer() {
  mkdirSync(LOG_DIR, { recursive: true });
  const log = openSync(join(LOG_DIR, `dev-${++starts}.log`), "w");
  server = spawn("pnpm", ["dev"], { cwd: ROOT, detached: true, stdio: ["ignore", log, log] });
  const started = Date.now();
  await until("the dev server", async () => (await fetch(`${target.appUrl}/login`)).ok, 120_000);
  // A cold server answers its first API calls with spurious 401s and 404s while routes compile.
  await fetch(`${target.appUrl}/api/approvals?status=pending`).catch(() => null);
  await sleep(4_000);
  say(`dev server up (pid ${server.pid}, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

function killDevServer() {
  if (server?.pid) process.kill(-server.pid, "SIGKILL");
  for (const pid of listeningPids(3000)) process.kill(pid, "SIGKILL");
  server = null;
}

/** Kills until nothing listens on :3000 and nothing answers there. */
async function killAndWait() {
  killDevServer();
  await until(
    "port 3000 to free up",
    async () => {
      for (const pid of listeningPids(3000)) process.kill(pid, "SIGKILL");
      if (listeningPids(3000).length > 0) return false;
      return fetch(`${target.appUrl}/login`).then(
        () => false,
        () => true,
      );
    },
    30_000,
  );
}

async function api(cookie: string, path: string, body?: unknown) {
  const response = await fetch(`${target.appUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", origin: target.appUrl, cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function control(method: string, path: string, body?: unknown) {
  const response = await fetch(`${target.workspaceUrl}/_control${path}`, {
    method,
    headers: {
      [CONTROL_HEADER]: env.FAKE_WORKSPACE_CONTROL_TOKEN || DEV_CONTROL_TOKEN,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`fake-workspace ${path} answered ${response.status}`);
  return response.status === 204 ? null : response.json();
}

/** The mails fake-workspace holds for this run: its tools send `agent:<runId>:<step>` as the key. */
async function mailsOf(runId: string) {
  const { value } = (await control("GET", "/mail")) as { value: { idempotencyKey: string | null; subject: string }[] };
  return value.filter((mail) => mail.idempotencyKey?.startsWith(`agent:${runId}:`));
}

const runRow = async (runId: string) =>
  (await db`SELECT status, workflow_run_id FROM runs WHERE id = ${runId}`)[0] as
    | { status: string; workflow_run_id: string | null }
    | undefined;
const eventTypes = async (runId: string) =>
  (await db`SELECT type, data FROM run_events WHERE run_id = ${runId} ORDER BY seq`).map((row) =>
    row.type === "status" ? `status:${row.data.to}` : String(row.type),
  );

async function signInAsLeo() {
  const { email } = world.user("kestrel", "leo.martin");
  const response = await signIn(target, email, world.tenant("kestrel").password);
  if (!response.ok) throw new Error(`leo.martin's sign-in answered ${response.status}`);
  return sessionCookie(response);
}

/** Starts a run asking for one mail to Tom, and waits for its approval. */
async function runToApproval(cookie: string, label: string) {
  const runId = crypto.randomUUID();
  const tom = world.user("kestrel", "tom.whitfield").email;
  const text =
    `Send one email to ${tom} with the subject "Kill proof ${label} ${runId.slice(0, 8)}" and the body ` +
    `"Checking that a send survives a restart." Don't search for anything first; just send that one email.`;
  await api(cookie, "/api/runs", { id: runId, message: { id: `m-${runId.slice(0, 8)}`, text } });
  say(`${label}: run ${runId} started`);
  const approval = await until(
    "the approval",
    async () => {
      const { approvals } = (await api(cookie, "/api/approvals?status=pending")) as {
        approvals: { id: string; runId: string; tool: string; input: unknown }[];
      };
      const status = (await runRow(runId))?.status;
      if (status && ["succeeded", "failed", "cancelled"].includes(status)) {
        throw new Error(`the run ended ${status} before asking: ${(await eventTypes(runId)).join(", ")}`);
      }
      return approvals.find((a) => a.runId === runId);
    },
    180_000,
  );
  say(`${label}: approval ${approval.id} for ${approval.tool} ${JSON.stringify(approval.input).slice(0, 160)}`);
  return { runId, approvalId: approval.id };
}

async function finished(runId: string) {
  return until(
    "the run to finish",
    async () => {
      const row = await runRow(runId);
      return row && ["succeeded", "failed", "cancelled", "timed_out"].includes(row.status) ? row.status : null;
    },
    // A step that died with the server runs again once its lease runs out (src/workflows/start-world.ts).
    300_000,
  );
}

async function killMidSend(cookie: string) {
  const { runId, approvalId } = await runToApproval(cookie, "kill");
  await control("POST", "/faults", {
    kind: "latency",
    latency_ms: SEND_LATENCY_MS,
    path_prefix: "/v1.0/users",
    count: 1,
  });
  await api(cookie, `/api/approvals/${approvalId}`, { decision: "approved" });
  say("kill: approved; send_mail held 15 s by a latency fault");
  await until("the tool call to start", async () => (await eventTypes(runId)).at(-1) === "status:running", 30_000);
  await sleep(2_500);
  const before = await mailsOf(runId);
  if (before.length !== 0) throw new Error("the mail landed before the kill: the proof proves nothing");
  await killAndWait();
  say(`kill: dev server killed mid-send (mails with the run's key so far: ${before.length})`);
  await sleep(SEND_LATENCY_MS);
  await startDevServer();
  const status = await finished(runId);
  const mails = await mailsOf(runId);
  say(`kill: run ${status}; mails with the run's key: ${mails.length}`);
  say(`kill: events: ${(await eventTypes(runId)).join(", ")}`);
  if (status !== "succeeded" || mails.length !== 1) throw new Error("kill proof failed");
  return { runId, mails: mails.length, key: mails[0].idempotencyKey };
}

async function approvalAcrossRestart(cookie: string) {
  const { runId, approvalId } = await runToApproval(cookie, "restart");
  await killAndWait();
  say("restart: dev server killed with the approval pending");
  await startDevServer();
  const fresh = await signInAsLeo();
  await api(fresh, `/api/approvals/${approvalId}`, { decision: "approved" });
  say("restart: approved after the restart");
  const status = await finished(runId);
  const mails = await mailsOf(runId);
  say(`restart: run ${status}; mails with the run's key: ${mails.length}`);
  if (status !== "succeeded" || mails.length !== 1) throw new Error("the approval across a restart didn't resume");
  return { runId, mails: mails.length };
}

async function main() {
  if ((env.AGENT_RUNNER?.trim() || "workflow") !== "workflow")
    throw new Error("the proof is for the Workflow runner: unset AGENT_RUNNER");
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY isn't set in .env.local: the proof uses a real model");
  if (listeningPids(3000).length > 0) throw new Error("something listens on :3000: stop the dev server first");
  await control("GET", "/mail");
  await startDevServer();
  try {
    const cookie = await signInAsLeo();
    const kill = await killMidSend(cookie);
    const restart = await approvalAcrossRestart(cookie);
    console.log(JSON.stringify({ kill, restart }, null, 2));
  } finally {
    await control("DELETE", "/faults").catch(() => {});
    killDevServer();
    await db.end();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    killDevServer();
    process.exit(1);
  },
);
