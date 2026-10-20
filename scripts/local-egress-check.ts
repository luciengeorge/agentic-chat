/**
 * `pnpm local:egress-check [--answer]`: shows that the app works with everything local while nothing leaves.
 *
 * 1. The network. Runs the probe (fixtures/local/egress-probe.sh) on the `airgap` Compose network, which has no
 *    route out. OpenAI, Cohere, Hugging Face, bare IPs and the host must all fail, each within a second; the
 *    database on the same network must answer. Then it removes the probe's database container, and only that.
 * 2. The process. With the egress monitor on (`#learn/local/egress`), a golden question goes through the app's
 *    retrieval on local models against `ac_local`: embedded by LM Studio, reranked by the cross-encoder, the ACL
 *    applied, audited. With `--answer` (the chat model loaded in LM Studio) it's rewritten and answered too. Not
 *    one connection may be refused. Then the hosted clients are tried, as a misconfigured app would: OpenAI's
 *    embeddings and Cohere's rerank, once with no retries and once with the app's retry settings.
 *
 * It writes fixtures/local/reports/<date>-egress.json and exits 1 when any check fails.
 */
import { createCohere } from "@ai-sdk/cohere";
import { createOpenAI } from "@ai-sdk/openai";
import { embedMany } from "ai";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { answer } from "#learn/generate/answer";
import { localConfig } from "#learn/local/config";
import { EgressBlockedError, guardEgress } from "#learn/local/egress";
import { CHAT_REASONING_EFFORT } from "#learn/model/config";
import { noRewriter } from "#learn/query/rewrite";
import { aiSdkReranker } from "#learn/rerank/rerank";
import { createRetrieve } from "#learn/retrieve/retrieve";
import { closeDb, dbFor } from "@/db/pool";
import { withTenantOn } from "@/db/tenant";
import { loadGolden } from "@/fixtures/golden";
import { loadWorld } from "@/fixtures/world";
import { embedderFromEnv, rerankerFromEnv, rewriterFromEnv } from "@/lib/retrieval.server";
import { chatModelFromEnv } from "@/routes/api/chat/-deps";

import { localDatabaseUrls } from "./local-common";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const withAnswer = process.argv.includes("--answer");
const FAIL_FAST_MS = 1000;

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}
const checks: Check[] = [];
const check = (name: string, passed: boolean, detail: string) => {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "ok  " : "FAIL"} ${name}: ${detail}`);
};

// 1. The network.
interface Probe {
  probe: string;
  target: string;
  reached: boolean;
  ms: number;
  detail: string;
}
const compose = (...args: string[]) =>
  execFileSync("docker", ["compose", "--profile", "airgap", ...args], { cwd: ROOT, encoding: "utf8" });
let probes: Probe[] = [];
try {
  probes = compose("run", "--rm", "airgap-probe")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Probe);
} finally {
  compose("rm", "--stop", "--force", "airgap-db");
}
for (const probe of probes) {
  const inside = probe.target.startsWith("airgap-db");
  check(
    `network: ${probe.probe} ${probe.target}`,
    inside ? probe.reached : !probe.reached && probe.ms < FAIL_FAST_MS,
    `${probe.reached ? "reached" : "refused"} in ${probe.ms} ms (${probe.detail})`,
  );
}
if (probes.length === 0) check("network: probe", false, "the probe printed nothing");

// 2. The process.
const guard = guardEgress();
const env = { ...process.env, MODEL_PROVIDER: "local" };
const urls = localDatabaseUrls(env);
const db = dbFor(urls.app);
const admin = dbFor(urls.admin);
const local: Record<string, unknown> = {};
try {
  const world = loadWorld();
  const question = loadGolden().find((q) => q.id === "expenses-meals")!;
  const [tenant] = await admin.$client<{ id: string }[]>`SELECT id FROM organization WHERE slug = ${question.tenant}`;
  const retrieve = createRetrieve({
    withTenant: (tenantId, fn) => withTenantOn(db, tenantId, fn),
    embedder: embedderFromEnv(env, { purpose: "query" }),
    reranker: rerankerFromEnv(env),
    rewriter: withAnswer ? rewriterFromEnv(env) : noRewriter,
  });
  const started = performance.now();
  const retrieval = await retrieve(
    { tenantId: tenant.id, userId: world.userId(question.tenant, question.user) },
    question.question,
  );
  local.retrieval = {
    question: question.question,
    seconds: Math.round(performance.now() - started) / 1000,
    top: retrieval.chunks.slice(0, 3).map((chunk) => ({ path: chunk.path, score: chunk.score })),
    rewritten: retrieval.rewritten,
  };
  const labelled = retrieval.chunks.findIndex((chunk) => chunk.path === question.relevant[0].path);
  check(
    "local: retrieval",
    labelled >= 0 && labelled < 3,
    `${retrieval.chunks.length} chunks in ${(local.retrieval as { seconds: number }).seconds} s; ` +
      `${question.relevant[0].path} at rank ${labelled + 1}`,
  );
  if (withAnswer) {
    const t0 = performance.now();
    let text = "";
    let cited: string[] = [];
    for await (const event of answer({
      question: question.question,
      retrieval,
      model: chatModelFromEnv(env),
      reasoningEffort: CHAT_REASONING_EFFORT,
      maxOutputTokens: 2000,
    })) {
      if (event.type === "done") {
        text = event.result.text;
        cited = event.result.report.citations.map((citation) => citation.path);
      }
    }
    local.answer = { text, cited, seconds: Math.round(performance.now() - t0) / 1000 };
    check("local: answer", cited.includes(question.relevant[0].path), `cites ${cited.join(", ") || "nothing"}`);
  } else {
    console.log("     local: answer skipped (pass --answer once LM Studio has the chat model loaded)");
  }
  check(
    "local: no connection left the machine",
    guard.blocked.length === 0,
    `${guard.blocked.length} refused; allowed ${[...new Set(guard.allowed)].join(", ")}`,
  );
} finally {
  await closeDb(urls.app);
  await closeDb(urls.admin);
}

// The hosted clients, as a misconfigured app would call them. The keys are placeholders: nothing is sent.
const hosted: Record<string, unknown> = {};
async function timed(name: string, fn: () => Promise<unknown>) {
  const before = guard.blocked.length;
  const t0 = performance.now();
  let error: unknown = null;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  const ms = Math.round(performance.now() - t0);
  // The AI SDK wraps the last failure in a RetryError (`lastError`), and fetch puts the socket's in `cause`.
  let cause = error;
  for (let depth = 0; depth < 5 && cause instanceof Error && !(cause instanceof EgressBlockedError); depth++) {
    cause = (cause as Error & { lastError?: unknown }).lastError ?? cause.cause;
  }
  hosted[name] = { ms, attempts: guard.blocked.length - before, error: error instanceof Error ? error.message : null };
  return { ms, blocked: cause instanceof EgressBlockedError, attempts: guard.blocked.length - before };
}
const openai = createOpenAI({ apiKey: "sk-airgap-check" });
const cohere = createCohere({ apiKey: "airgap-check" });
// With no retries a blocked call fails in milliseconds. With the app's retries (2 for OpenAI, 5 for Cohere, backing
// off from 2 s) the same refusal takes seconds to a minute: that's why local mode never builds a hosted client.
for (const [label, retries] of [
  ["no retries", 0],
  ["the app's retries", undefined],
] as const) {
  const embed = await timed(`openai embeddings, ${label}`, () =>
    embedMany({ model: openai.embedding("text-embedding-3-small"), values: ["x"], maxRetries: retries }),
  );
  check(
    `hosted: OpenAI embeddings, ${label}`,
    embed.blocked && (retries !== 0 || embed.ms < FAIL_FAST_MS),
    `failed in ${embed.ms} ms after ${embed.attempts} attempts`,
  );
  const rerank = await timed(`cohere rerank, ${label}`, () =>
    aiSdkReranker(cohere.reranking("rerank-v4.0-fast"), "cohere", { maxRetries: retries }).rerank("x", ["y"], 1),
  );
  check(
    `hosted: Cohere rerank, ${label}`,
    rerank.blocked && (retries !== 0 || rerank.ms < FAIL_FAST_MS),
    `failed in ${rerank.ms} ms after ${rerank.attempts} attempts`,
  );
}
guard.restore();

const date = new Date().toISOString().slice(0, 10);
const out = join(ROOT, "fixtures/local/reports");
mkdirSync(out, { recursive: true });
const report = {
  date,
  models: localConfig(env),
  network: probes,
  local,
  hosted,
  checks,
  passed: checks.every((entry) => entry.passed),
};
writeFileSync(join(out, `${date}-egress.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(`${report.passed ? "passed" : "FAILED"}; wrote fixtures/local/reports/${date}-egress.json`);
process.exitCode = report.passed ? 0 : 1;
