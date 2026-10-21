/**
 * `pnpm local:bench [--questions N]`: where the time goes on local models. For the first N golden answer
 * questions (default 10) it runs the app's retrieval against `ac_local` with each model wrapped in a timer: the
 * query embedding (LM Studio), the rerank of the candidates (the cross-encoder, in this process), and the rest
 * (the database's searches, the ACL decision, the audit). Then it reranks one question's candidates at several
 * batch sizes. When LM Studio has the chat model loaded it also streams one answer and reports the time to the
 * first token and tokens per second. Prints a table and writes fixtures/local/reports/<date>-bench.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Embedder } from "#learn/embed/embed";
import type { Reranker } from "#learn/rerank/rerank";

import { answer } from "#learn/generate/answer";
import { localConfig } from "#learn/local/config";
import { crossEncoderReranker, loadCrossEncoder } from "#learn/local/rerank";
import { CHAT_REASONING_EFFORT } from "#learn/model/config";
import { noRewriter } from "#learn/query/rewrite";
import { createRetrieve } from "#learn/retrieve/retrieve";
import { closeDb, dbFor } from "@/db/pool";
import { withTenantOn } from "@/db/tenant";
import { loadGolden } from "@/fixtures/golden";
import { loadWorld } from "@/fixtures/world";
import { embedderFromEnv } from "@/lib/retrieval.server";
import { chatModelFromEnv } from "@/routes/api/chat/-deps";

import { localDatabaseUrls } from "./local-common";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argIndex = process.argv.indexOf("--questions");
const N = argIndex > 0 ? Number(process.argv[argIndex + 1]) : 10;
const env = { ...process.env, MODEL_PROVIDER: "local" };
const config = localConfig(env);
const urls = localDatabaseUrls(env);

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : Number.NaN;
};
const ms = (t0: number) => Math.round(performance.now() - t0);

const timings = { embed: [] as number[], rerank: [] as number[], total: [] as number[], pairs: [] as number[] };
let lastRerank = null as { query: string; documents: string[] } | null;

const loadStarted = performance.now();
const encoder = await loadCrossEncoder(config);
const loadMs = ms(loadStarted);

const base = embedderFromEnv(env, { purpose: "query" });
const embedder: Embedder = {
  ...base,
  async embed(values) {
    const t0 = performance.now();
    const out = await base.embed(values);
    timings.embed.push(ms(t0));
    return out;
  },
};
const cross = crossEncoderReranker(async () => encoder, "bench");
const reranker: Reranker = {
  name: cross.name,
  async rerank(query, documents, topN) {
    const t0 = performance.now();
    const out = await cross.rerank(query, documents, topN);
    timings.rerank.push(ms(t0));
    timings.pairs.push(documents.length);
    lastRerank = { query, documents };
    return out;
  },
};

const db = dbFor(urls.app);
const admin = dbFor(urls.admin);
const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), models: config };
try {
  const world = loadWorld();
  const tenants = new Map(
    (await admin.$client<{ id: string; slug: string }[]>`SELECT id, slug FROM organization`).map((r) => [r.slug, r.id]),
  );
  const retrieve = createRetrieve({
    withTenant: (tenantId, fn) => withTenantOn(db, tenantId, fn),
    embedder,
    reranker,
    rewriter: noRewriter,
  });
  const questions = loadGolden()
    .filter((q) => q.expect === "answer")
    .slice(0, N);
  let lastRetrieval = null;
  for (const q of questions) {
    const t0 = performance.now();
    lastRetrieval = await retrieve(
      { tenantId: tenants.get(q.tenant)!, userId: world.userId(q.tenant, q.user) },
      q.question,
    );
    timings.total.push(ms(t0));
  }
  const rest = timings.total.map((total, i) => total - (timings.embed[i] ?? 0) - (timings.rerank[i] ?? 0));
  report.retrieval = {
    questions: questions.length,
    rerankerLoadMs: loadMs,
    medianMs: {
      total: median(timings.total),
      queryEmbedding: median(timings.embed),
      rerank: median(timings.rerank),
      rest: median(rest),
    },
    medianPairs: median(timings.pairs),
  };

  const batches: Record<number, number> = {};
  if (lastRerank) {
    const { query, documents } = lastRerank;
    for (const size of [1, 4, 8, 16, 30]) {
      const timer = crossEncoderReranker(async () => encoder, "bench", { batchSize: size });
      await timer.rerank(query, documents, 8);
      const t0 = performance.now();
      await timer.rerank(query, documents, 8);
      batches[size] = ms(t0);
    }
  }
  report.rerankBatchMs = { pairs: lastRerank?.documents.length ?? 0, byBatchSize: batches };

  const loaded = await fetch(`${config.baseURL}/models`)
    .then(async (r) => ((await r.json()) as { data: { id: string }[] }).data.map((m) => m.id))
    .catch(() => [] as string[]);
  if (loaded.includes(config.chatModel) && lastRetrieval) {
    const q = questions.at(-1)!;
    const t0 = performance.now();
    let first = 0;
    let usage = null;
    for await (const event of answer({
      question: q.question,
      retrieval: lastRetrieval,
      model: chatModelFromEnv(env),
      reasoningEffort: CHAT_REASONING_EFFORT,
      maxOutputTokens: 2000,
    })) {
      if (event.type === "text-delta" && !first) first = performance.now();
      if (event.type === "done") usage = event.result.usage;
    }
    const end = performance.now();
    const outputTokens = usage?.outputTokens ?? 0;
    report.chat = {
      model: config.chatModel,
      timeToFirstTokenMs: first ? Math.round(first - t0) : null,
      totalMs: Math.round(end - t0),
      inputTokens: usage?.inputTokens ?? null,
      outputTokens,
      // Over the whole call: prompt processing and reasoning included.
      tokensPerSecond: outputTokens ? Math.round((outputTokens / ((end - t0) / 1000)) * 10) / 10 : null,
    };
  } else {
    report.chat = { model: config.chatModel, pending: `LM Studio doesn't have ${config.chatModel} loaded` };
  }
} finally {
  await closeDb(urls.app);
  await closeDb(urls.admin);
}

console.log(JSON.stringify(report, null, 2));
const out = join(ROOT, "fixtures/local/reports");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `${report.date}-bench.json`), `${JSON.stringify(report, null, 2)}\n`);
