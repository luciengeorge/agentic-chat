/**
 * `pnpm eval`: asks the golden set (fixtures/golden/questions.yaml) of the live stack with the real models, as each
 * question's user, and writes a dated report to fixtures/golden/reports/.
 *
 *   pnpm eval                    retrieval and answers (the committed baseline)
 *   pnpm eval --retrieval-only   retrieval only: no answer calls, so cheap to rerun
 *   pnpm eval --only a,b         just these questions; prints, writes no report
 *
 * It runs `retrieve()` and `answer()` in-process against the database `pnpm dev` uses, as the app role, the way
 * `POST /api/chat` does: retrieval at k = 10 for the metrics, and the first 8 of those (the app's k) to the model.
 * The leak gates use their own oracle (world.yaml and the manifest's sharing), not the app's ACL code.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Reranker } from "#learn/rerank/rerank";
import type { RetrievedChunk } from "#learn/retrieve/types";

import { checkAnswer, checkGates, type CheckResult } from "#learn/eval/checks";
import { judge, ndcgAtK, recallAtK, reciprocalRank } from "#learn/eval/metrics";
import { BAR, summarize, type Scores, type Summary } from "#learn/eval/summary";
import { answer, type AnswerResult } from "#learn/generate/answer";
import { aiSdkChatModel } from "#learn/model/ai-sdk";
import { CHAT_MODEL, CHAT_REASONING_EFFORT } from "#learn/model/config";
import { modelRewriter } from "#learn/query/rewrite";
import { createRetrieve, DEFAULT_SETTINGS } from "#learn/retrieve/retrieve";
import { closeDb, dbFor } from "@/db/pool";
import { withTenantOn } from "@/db/tenant";
import { Corpus } from "@/fixtures/corpus";
import { type GoldenQuestion, loadGolden, secretsOf } from "@/fixtures/golden";
import { loadWorld } from "@/fixtures/world";
import { acEnv } from "@/lib/env";
import { embedderFromEnv, rerankerFromEnv } from "@/lib/retrieval.server";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPORTS = join(ROOT, "fixtures/golden/reports");
const K = 10;
/** The app answers from `retrieve()`'s default k. */
const ANSWER_K = DEFAULT_SETTINGS.k;
const MAX_OUTPUT_TOKENS = 2000;
/** A Cohere trial key allows 10 rerank calls a minute. */
const COHERE_INTERVAL_MS = 6500;

/** USD per million tokens (OpenAI's list prices, October 2026). Answer usage has no cache split, so it's priced uncached. */
const PRICES = { chatInput: 0.1, chatCachedInput: 0.01, chatOutput: 0.5, embedding: 0.02 };

interface Usage {
  embeddingTokens: number;
  rewrite: { calls: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
  answer: { calls: number; inputTokens: number; outputTokens: number; reasoningTokens: number };
  rerankCalls: number;
}

interface QuestionReport {
  id: string;
  tenant: string;
  user: string;
  question: string;
  expect: GoldenQuestion["expect"];
  traps: string[];
  labels: { path: string; page: number | null }[];
  rewritten: string[];
  ranked: { rank: number; path: string; pages: string | null; label: number | null; score: number }[];
  scores: Scores | null;
  leaks: string[];
  crossTenant: string[];
  answer: {
    text: string;
    abstained: boolean;
    flagged: boolean;
    cited: { path: string; page: number | null }[];
    dropped: number;
    check: CheckResult;
    usage: AnswerResult["usage"];
  } | null;
  error: string | null;
  seconds: number;
}

function parseArgs(argv: string[]) {
  let retrievalOnly = false;
  let only: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--retrieval-only") retrievalOnly = true;
    else if (arg === "--only") only = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (arg.startsWith("--only=")) only = arg.slice("--only=".length).split(",").filter(Boolean);
    else throw new Error(`unknown argument ${arg}; try --retrieval-only or --only id,id`);
  }
  return { retrievalOnly, only };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Counts calls, and spaces them out for a rate-limited Cohere key. */
function counted(reranker: Reranker, usage: Usage): Reranker {
  let last = 0;
  const interval = reranker.name.startsWith("cohere") ? COHERE_INTERVAL_MS : 0;
  return {
    name: reranker.name,
    async rerank(query, documents, topN) {
      if (documents.length === 0) return [];
      const wait = last + interval - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      usage.rerankCalls += 1;
      return reranker.rerank(query, documents, topN);
    },
  };
}

const pages = (chunk: Pick<RetrievedChunk, "pageStart" | "pageEnd">) =>
  chunk.pageStart === null
    ? null
    : chunk.pageEnd !== null && chunk.pageEnd !== chunk.pageStart
      ? `${chunk.pageStart}-${chunk.pageEnd}`
      : String(chunk.pageStart);

function cost(usage: Usage) {
  const r = usage.rewrite;
  const a = usage.answer;
  const rewrite =
    ((r.inputTokens - r.cachedInputTokens) * PRICES.chatInput +
      r.cachedInputTokens * PRICES.chatCachedInput +
      r.outputTokens * PRICES.chatOutput) /
    1e6;
  const answers = (a.inputTokens * PRICES.chatInput + a.outputTokens * PRICES.chatOutput) / 1e6;
  const embeddings = (usage.embeddingTokens * PRICES.embedding) / 1e6;
  return { rewrite, answers, embeddings, total: rewrite + answers + embeddings };
}

async function main() {
  const { retrievalOnly, only } = parseArgs(process.argv.slice(2));
  if (acEnv() !== "dev") throw new Error(`pnpm eval runs against the dev stack; AC_ENV is ${acEnv()}`);
  if (!process.env.OPENAI_API_KEY)
    throw new Error("pnpm eval needs OPENAI_API_KEY: fake models would score nothing real");
  const databaseUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!databaseUrl || !adminUrl) throw new Error("DATABASE_URL and DATABASE_ADMIN_URL must be set (.env.local)");

  const world = loadWorld();
  const corpus = new Corpus(world);
  const all = loadGolden();
  const questions = only ? all.filter((q) => only.includes(q.id)) : all;
  if (only && questions.length !== only.length) {
    throw new Error(`no golden question ${only.filter((id) => !all.some((q) => q.id === id)).join(", ")}`);
  }

  const db = dbFor(databaseUrl);
  const admin = dbFor(adminUrl);
  const usage: Usage = {
    embeddingTokens: 0,
    rewrite: { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    answer: { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    rerankCalls: 0,
  };
  const reports: QuestionReport[] = [];
  const started = new Date();
  const models: Record<string, string | null> = {
    rewriter: `${CHAT_MODEL} (${CHAT_REASONING_EFFORT})`,
    answer: retrievalOnly ? null : `${CHAT_MODEL} (${CHAT_REASONING_EFFORT})`,
  };
  try {
    const tenantIds = new Map(
      (await admin.$client<{ id: string; slug: string }[]>`SELECT id, slug FROM organization`).map((row) => [
        row.slug,
        row.id,
      ]),
    );
    // The owner role sees every tenant's documents, so a chunk from the wrong tenant can be caught.
    const documentTenant = new Map(
      (await admin.$client<{ id: string; tenant_id: string }[]>`SELECT id, tenant_id FROM documents`).map((row) => [
        row.id,
        row.tenant_id,
      ]),
    );

    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const countRewrites: LanguageModelMiddleware = {
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        usage.rewrite.calls += 1;
        usage.rewrite.inputTokens += result.usage.inputTokens.total ?? 0;
        usage.rewrite.cachedInputTokens += result.usage.inputTokens.cacheRead ?? 0;
        usage.rewrite.outputTokens += result.usage.outputTokens.total ?? 0;
        return result;
      },
    };
    // The same rewriter `rewriterFromEnv` builds, with its usage counted.
    const rewriter = modelRewriter(
      wrapLanguageModel({ model: openai(CHAT_MODEL), middleware: countRewrites }),
      CHAT_REASONING_EFFORT,
    );
    const embedder = embedderFromEnv(process.env, { onUsage: (tokens) => (usage.embeddingTokens += tokens) });
    const reranker = counted(rerankerFromEnv(), usage);
    models.embedder = embedder.version;
    models.reranker = reranker.name;
    const retrieve = createRetrieve({
      withTenant: (tenantId, fn) => withTenantOn(db, tenantId, fn),
      embedder,
      reranker,
      rewriter,
    });
    const model = aiSdkChatModel(openai(CHAT_MODEL));

    for (const [n, q] of questions.entries()) {
      const t0 = performance.now();
      const tenantId = tenantIds.get(q.tenant);
      if (!tenantId) throw new Error(`no ${q.tenant} organization; run \`pnpm db:seed\``);
      const readable = corpus.readable(q.tenant, q.user);
      const report: QuestionReport = {
        id: q.id,
        tenant: q.tenant,
        user: q.user,
        question: q.question,
        expect: q.expect,
        traps: q.traps,
        labels: q.relevant.map(({ path, page }) => ({ path, page })),
        rewritten: [],
        ranked: [],
        scores: null,
        leaks: [],
        crossTenant: [],
        answer: null,
        error: null,
        seconds: 0,
      };
      try {
        const retrieval = await retrieve({ tenantId, userId: world.userId(q.tenant, q.user) }, q.question, { k: K });
        report.rewritten = retrieval.rewritten;
        const judged = judge(retrieval.chunks, report.labels);
        report.ranked = retrieval.chunks.map((chunk, i) => ({
          rank: i + 1,
          path: chunk.path,
          pages: pages(chunk),
          label: judged[i],
          score: Math.round(chunk.score * 1000) / 1000,
        }));
        if (q.expect === "answer") {
          report.scores = {
            recallAt10: recallAtK(judged, report.labels.length, K),
            reciprocalRank: reciprocalRank(judged),
            ndcgAt10: ndcgAtK(judged, report.labels.length, K),
          };
        }

        let result: AnswerResult | null = null;
        if (!retrievalOnly) {
          for await (const event of answer({
            question: q.question,
            retrieval: { ...retrieval, chunks: retrieval.chunks.slice(0, ANSWER_K) },
            model,
            reasoningEffort: CHAT_REASONING_EFFORT,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
          })) {
            if (event.type === "done") result = event.result;
          }
          if (result!.usage) {
            usage.answer.calls += 1;
            usage.answer.inputTokens += result!.usage.inputTokens ?? 0;
            usage.answer.outputTokens += result!.usage.outputTokens ?? 0;
            usage.answer.reasoningTokens += result!.usage.reasoningTokens ?? 0;
          }
        }
        const citedPaths = result?.report.citations.map((citation) => citation.path) ?? [];
        const gates = checkGates(
          { tenantId, retrieved: retrieval.chunks, citedPaths, text: result?.text ?? null, secrets: secretsOf(q) },
          {
            tenantOf: (documentId) => documentTenant.get(documentId),
            canRead: (path) => readable.has(path),
          },
        );
        report.leaks = gates.leaks;
        report.crossTenant = gates.crossTenant;
        if (result) {
          report.answer = {
            text: result.text,
            abstained: result.abstained,
            flagged: result.flagged,
            cited: result.report.citations.map(({ path, page }) => ({ path, page })),
            dropped: result.report.dropped.length,
            check: checkAnswer(q.expect, report.labels, {
              text: result.text,
              abstained: result.abstained,
              citedPaths,
            }),
            usage: result.usage,
          };
        }
      } catch (error) {
        report.error = error instanceof Error ? error.message : String(error);
      }
      report.seconds = Math.round(performance.now() - t0) / 1000;
      reports.push(report);
      const s = report.scores;
      process.stderr.write(
        `${String(n + 1).padStart(2)}/${questions.length} ${q.id.padEnd(28)} ` +
          (report.error
            ? `ERROR ${report.error}`
            : `${s ? `R@10 ${s.recallAt10.toFixed(2)} RR ${s.reciprocalRank.toFixed(2)}` : "abstain case     "}` +
              `${report.answer ? ` answer ${report.answer.check.passed ? "ok" : `FAIL (${report.answer.check.reasons.join("; ")})`}` : ""}` +
              `${report.leaks.length || report.crossTenant.length ? ` LEAK ${[...report.leaks, ...report.crossTenant].join(", ")}` : ""}`) +
          ` ${report.seconds}s\n`,
      );
    }
  } finally {
    await closeDb(databaseUrl);
    await closeDb(adminUrl);
  }

  const summary = summarize(
    reports.map((r) => ({
      id: r.id,
      expect: r.expect,
      traps: r.traps,
      scores: r.scores,
      leaks: r.leaks,
      crossTenant: r.crossTenant,
      answer: r.answer?.check ?? null,
      error: r.error,
    })),
  );
  const run = {
    date: started.toISOString().slice(0, 10),
    startedAt: started.toISOString(),
    mode: retrievalOnly ? "retrieval-only" : "full",
    models,
    settings: { ...DEFAULT_SETTINGS, k: K, answerK: ANSWER_K },
    bar: BAR,
    usage,
    costUsd: cost(usage),
  };
  const markdown = renderMarkdown(run, summary, reports);
  if (!only) {
    mkdirSync(REPORTS, { recursive: true });
    const base = join(REPORTS, `${run.date}-${run.mode}`);
    writeFileSync(`${base}.json`, `${JSON.stringify({ run, summary, questions: reports }, null, 2)}\n`);
    writeFileSync(`${base}.md`, markdown);
    process.stderr.write(`wrote ${base}.md and .json\n`);
  }
  process.stdout.write(`${headline(run, summary)}\n`);
  process.exitCode = summary.gates.passed && summary.scores.passed ? 0 : 1;
}

type Run = {
  date: string;
  startedAt: string;
  mode: string;
  models: Record<string, string | null>;
  settings: Record<string, number>;
  bar: typeof BAR;
  usage: Usage;
  costUsd: ReturnType<typeof cost>;
};

const fixed = (n: number) => (Number.isNaN(n) ? "n/a" : n.toFixed(3));

function headline(run: Run, summary: Summary): string {
  const g = summary.gates;
  return [
    `golden set, ${run.mode}: ${summary.questions} questions`,
    `gates ${g.passed ? "PASS" : "FAIL"}: leaks [${g.leaks.join(", ")}], cross-tenant [${g.crossTenant.join(", ")}], ` +
      `abstentions missed [${g.abstentionsMissed.join(", ")}], errors [${g.errors.join(", ")}]`,
    `scores ${summary.scores.passed ? "PASS" : "FAIL"}: recall@10 ${fixed(summary.scores.recallAt10)} (bar ${BAR.recallAt10}), ` +
      `MRR ${fixed(summary.scores.mrr)} (bar ${BAR.mrr}), NDCG@10 ${fixed(summary.scores.ndcgAt10)}`,
    summary.answers
      ? `answers: ${summary.answers.passed}/${summary.answers.total} cite a labelled document` +
        (summary.answers.failed.length ? ` (failed: ${summary.answers.failed.join(", ")})` : "")
      : "answers: not run",
    `cost: $${run.costUsd.total.toFixed(4)}; embeddings ${run.usage.embeddingTokens} tokens; rewrites ` +
      `${run.usage.rewrite.inputTokens} in / ${run.usage.rewrite.outputTokens} out; answers ` +
      `${run.usage.answer.inputTokens} in / ${run.usage.answer.outputTokens} out; ${run.usage.rerankCalls} rerank calls`,
  ].join("\n");
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ");

function renderMarkdown(run: Run, summary: Summary, reports: QuestionReport[]): string {
  const lines: string[] = [];
  lines.push(`# Golden set: ${run.date} (${run.mode})`, "");
  lines.push(
    `Started ${run.startedAt}. Embeddings \`${run.models.embedder}\`, reranker \`${run.models.reranker}\`, rewriter ` +
      `\`${run.models.rewriter}\`, answers \`${run.models.answer ?? "not run"}\`. Retrieval at k = ${run.settings.k} ` +
      `(${run.settings.perList} per list, ${run.settings.candidates} candidates, ${run.settings.rerankDepth} reranked); ` +
      `answers from the first ${run.settings.answerK}.`,
    "",
  );
  lines.push("```", headline(run, summary), "```", "");

  lines.push(
    "## Scores by trap (answer cases)",
    "",
    "| Trap | Questions | recall@10 | MRR | NDCG@10 |",
    "|---|---:|---:|---:|---:|",
  );
  for (const [trap, a] of Object.entries(summary.byTrap)) {
    lines.push(`| ${trap} | ${a.questions} | ${fixed(a.recallAt10)} | ${fixed(a.mrr)} | ${fixed(a.ndcgAt10)} |`);
  }
  lines.push(
    `| **all** | ${summary.scores.questions} | ${fixed(summary.scores.recallAt10)} | ${fixed(summary.scores.mrr)} | ${fixed(summary.scores.ndcgAt10)} |`,
    "",
  );

  lines.push(
    "## Questions",
    "",
    "| Question | User | Expect | recall@10 | RR | NDCG@10 | Answer | Gates |",
    "|---|---|---|---:|---:|---:|---|---|",
  );
  for (const r of reports) {
    const answerCell = r.error
      ? `error: ${cell(r.error)}`
      : r.answer
        ? r.answer.check.passed
          ? r.answer.abstained
            ? "abstained"
            : r.answer.flagged
              ? `cited (flagged: ${r.answer.dropped} dropped)`
              : "cited"
          : `FAIL: ${r.answer.check.reasons.join("; ")}`
        : "";
    const gates = [...r.leaks, ...r.crossTenant.map((p) => `other tenant: ${p}`)];
    lines.push(
      `| ${r.id} | ${r.tenant}/${r.user} | ${r.expect} | ${r.scores ? fixed(r.scores.recallAt10) : ""} | ` +
        `${r.scores ? fixed(r.scores.reciprocalRank) : ""} | ${r.scores ? fixed(r.scores.ndcgAt10) : ""} | ` +
        `${cell(answerCell)} | ${gates.length ? cell(gates.join("; ")) : "ok"} |`,
    );
  }
  lines.push("");

  const misses = reports.filter(
    (r) =>
      r.error ||
      r.leaks.length ||
      r.crossTenant.length ||
      (r.scores && r.scores.reciprocalRank < 1) ||
      (r.answer && (!r.answer.check.passed || r.answer.flagged)),
  );
  lines.push(
    "## Misses",
    "",
    "Every question with a gate hit, an error, a label missing from the top 10 or not at rank 1, or a failed or flagged answer.",
    "",
  );
  if (misses.length === 0) lines.push("None.", "");
  for (const r of misses) {
    lines.push(`### ${r.id}`, "", `${r.tenant}/${r.user}: ${r.question}`, "");
    lines.push(
      `Labels: ${r.labels.map((l, i) => `[${i}] ${l.path}${l.page === null ? "" : ` p${l.page}`}`).join("; ") || "none"}`,
      "",
    );
    if (r.rewritten.length) lines.push(`Rewrites: ${r.rewritten.map((w) => `"${w}"`).join(", ")}`, "");
    lines.push("Top 10:", "");
    for (const c of r.ranked) {
      lines.push(
        `${c.rank}. ${c.path}${c.pages ? ` p${c.pages}` : ""} (${c.score})${c.label === null ? "" : ` finds [${c.label}]`}`,
      );
    }
    if (r.ranked.length === 0) lines.push("(nothing)");
    lines.push("");
    if (r.answer) {
      lines.push(`Answer${r.answer.abstained ? " (abstained)" : ""}${r.answer.flagged ? " (flagged)" : ""}:`, "");
      lines.push(...r.answer.text.split("\n").map((line) => `> ${line}`), "");
    }
  }

  lines.push(
    "## Usage",
    "",
    `- Embeddings: ${run.usage.embeddingTokens} tokens ($${run.costUsd.embeddings.toFixed(5)})`,
    `- Query rewrites: ${run.usage.rewrite.calls} calls, ${run.usage.rewrite.inputTokens} input (${run.usage.rewrite.cachedInputTokens} cached) and ${run.usage.rewrite.outputTokens} output tokens ($${run.costUsd.rewrite.toFixed(5)})`,
    `- Answers: ${run.usage.answer.calls} calls, ${run.usage.answer.inputTokens} input and ${run.usage.answer.outputTokens} output tokens, ${run.usage.answer.reasoningTokens} of them reasoning ($${run.costUsd.answers.toFixed(5)}, priced uncached)`,
    `- Rerank: ${run.usage.rerankCalls} calls (a Cohere trial key bills nothing)`,
    `- Total: $${run.costUsd.total.toFixed(4)}`,
    "",
  );
  return lines.join("\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
