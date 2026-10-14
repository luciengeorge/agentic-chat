/**
 * `pnpm vectors:bench`: section 06's experiments over the real dev corpus. It copies every current chunk embedding
 * into a scratch database (`ac_vectors_bench`, dropped at the end), so the app's tables and indexes are never
 * touched, then measures recall@10 and latency for:
 *
 * - exact search (a sequential scan) against HNSW, across the build knobs (m, ef_construction) and ef_search;
 * - text-embedding-3 vectors truncated to 256, 512 and 1,024 dimensions;
 * - halfvec (2-byte floats), and binary quantisation with and without rescoring by the full vectors;
 *
 * with the bytes each takes. The queries are the golden questions, embedded once and cached in
 * fixtures/vectors/cache/ (gitignored), so reruns cost nothing. The report goes to fixtures/vectors/reports/.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import type { Tx } from "@/db/tenant";

import { annNearest, buildHnswIndex, type HnswKnobs, PGVECTOR_DEFAULTS, type VectorOps } from "#learn/vectors/hnsw";
import { binaryRescoreNearest } from "#learn/vectors/quantize";
import { exactNearest, recallAtK } from "#learn/vectors/recall";
import { createScratchTable, loadScratchTable, type ScratchTable, truncatedColumn } from "#learn/vectors/scratch";
import { bytesPerVector, relationBytes, tableBytes } from "#learn/vectors/sizing";
import { truncateEmbedding } from "#learn/vectors/truncate";
import { createDb } from "@/db/create";
import { loadGolden } from "@/fixtures/golden";
import { acEnv } from "@/lib/env";
import { embedderFromEnv } from "@/lib/retrieval.server";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, "fixtures/vectors/cache/query-embeddings.json");
const REPORTS = join(ROOT, "fixtures/vectors/reports");
const SCRATCH_DB = "ac_vectors_bench";
const TABLE = "bench_vectors";
const K = 10;
const DIMENSIONS = 1536;
const TRUNCATIONS = [256, 512, 1024];
const KNOBS: HnswKnobs[] = [
  { m: 4, efConstruction: 16 },
  { m: 8, efConstruction: 32 },
  PGVECTOR_DEFAULTS,
  { m: 32, efConstruction: 128 },
];
const EF_SEARCH = [10, 20, 40, 100, 200];
/** What the app's vector search uses. */
const APP_EF_SEARCH = 100;
const OVERFETCH = [10, 40, 100, 200];

interface Measured {
  recall: number;
  medianMs: number;
  p95Ms: number;
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

/** Embeds the questions, or reads them from the cache when the model and text match. */
async function queryEmbeddings(questions: string[]): Promise<{ vectors: number[][]; tokens: number }> {
  const embedder = embedderFromEnv(process.env, { onUsage: (n) => (tokens += n) });
  let tokens = 0;
  const key = (text: string) => createHash("sha256").update(`${embedder.version}\n${text}`).digest("hex");
  const cache: Record<string, number[]> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
  const missing = questions.filter((q) => !cache[key(q)]);
  if (missing.length) {
    if (!embedder.version.startsWith("text-embedding-3")) {
      throw new Error(`the bench needs OpenAI embeddings; got ${embedder.version}. Set OPENAI_API_KEY.`);
    }
    const vectors = await embedder.embed(missing);
    missing.forEach((q, i) => (cache[key(q)] = vectors[i]));
    mkdirSync(join(CACHE, ".."), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(cache));
  }
  return { vectors: questions.map((q) => cache[key(q)]), tokens };
}

async function main() {
  if (acEnv() !== "dev") throw new Error(`the bench runs against the dev stack; AC_ENV is ${acEnv()}`);
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error("DATABASE_ADMIN_URL must be set (.env.local)");

  const questions = loadGolden().map((q) => q.question);
  const { vectors: queries, tokens } = await queryEmbeddings(questions);

  const source = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const rows = await source<{ id: string; embedding: string }[]>`
    SELECT c.id::text AS id, c.embedding::text AS embedding
    FROM chunks c JOIN documents d ON d.id = c.document_id AND d.version = c.document_version
    WHERE d.status = 'ready' AND c.embedding_model_version = ${`text-embedding-3-small@${DIMENSIONS}`}
    ORDER BY c.id`;
  if (rows.length === 0) throw new Error("no embedded chunks in the dev database; run `pnpm db:embed`");
  await source.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await source.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  const scratchUrl = new URL(adminUrl);
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  const db = createDb(scratchUrl.toString());
  const log = (line: string) => process.stderr.write(`${line}\n`);

  try {
    await db.$client`CREATE EXTENSION IF NOT EXISTS vector`;
    const table: ScratchTable = { name: TABLE, dimensions: DIMENSIONS, truncations: TRUNCATIONS };
    await createScratchTable(db, table);
    // Identical chunks (a repeated header page, say) have identical vectors, which tie: an exact scan and HNSW
    // could each pick a different one of the twins and the recall would count a miss. One row per vector.
    const distinct = [...new Map(rows.map((row) => [row.embedding, row])).values()];
    await loadScratchTable(
      db,
      table,
      distinct.map((row) => ({ id: row.id, embedding: JSON.parse(row.embedding) as number[] })),
    );
    log(`copied ${distinct.length} distinct chunk embeddings of ${rows.length}; ${queries.length} queries`);

    const tx = <T>(fn: (tx: Tx) => Promise<T>) => db.transaction(fn);
    /** Runs every query once to warm the cache, then again timed, and scores each against the truth. */
    async function measure(search: (q: number[]) => Promise<string[]>, truth: string[][]): Promise<Measured> {
      for (const q of queries) await search(q);
      const ms: number[] = [];
      let recall = 0;
      for (const [i, q] of queries.entries()) {
        const started = performance.now();
        const found = await search(q);
        ms.push(performance.now() - started);
        recall += recallAtK(found, truth[i], K) / queries.length;
      }
      return { recall, medianMs: percentile(ms, 0.5), p95Ms: percentile(ms, 0.95) };
    }

    const full = (q: number[]) => ({
      table: TABLE,
      column: "embedding",
      type: "vector" as const,
      dimensions: DIMENSIONS,
      embedding: q,
      k: K,
    });
    const truth: string[][] = [];
    for (const q of queries) truth.push(await tx((t) => exactNearest(t, full(q))));
    const exact = await measure((q) => tx((t) => exactNearest(t, full(q))), truth);
    log(`exact: ${exact.medianMs.toFixed(2)} ms median`);

    const build = async (name: string, column: string, ops: VectorOps, knobs = PGVECTOR_DEFAULTS) => {
      const { ms } = await buildHnswIndex(db, { name, table: TABLE, column, ops, knobs });
      return { buildMs: ms, bytes: await relationBytes(db, name) };
    };
    const drop = (name: string) => db.$client.unsafe(`DROP INDEX ${name}`);

    // 1. HNSW knobs: build options against per-query ef_search.
    const grid: { knobs: HnswKnobs; buildMs: number; bytes: number; byEf: (Measured & { efSearch: number })[] }[] = [];
    for (const knobs of KNOBS) {
      const built = await build("bench_hnsw", "embedding", "vector_cosine_ops", knobs);
      const byEf = [];
      for (const efSearch of EF_SEARCH) {
        byEf.push({ efSearch, ...(await measure((q) => tx((t) => annNearest(t, { ...full(q), efSearch })), truth)) });
      }
      grid.push({ knobs, ...built, byEf });
      log(`m=${knobs.m} ef_construction=${knobs.efConstruction}: ${(built.buildMs / 1000).toFixed(1)} s build`);
      await drop("bench_hnsw");
    }

    // 2. Variants, each with pgvector's default build knobs and the app's ef_search.
    interface Variant extends Measured {
      name: string;
      bytesPerVector: number;
      indexBytes: number | null;
      buildMs: number | null;
      exactRecall: number | null;
    }
    const defaults = grid.find((g) => g.knobs === PGVECTOR_DEFAULTS)!;
    const variants: Variant[] = [
      {
        name: "vector(1536), exact scan",
        bytesPerVector: bytesPerVector("vector", DIMENSIONS),
        indexBytes: null,
        buildMs: null,
        exactRecall: 1,
        ...exact,
      },
      {
        name: "vector(1536), HNSW",
        bytesPerVector: bytesPerVector("vector", DIMENSIONS),
        indexBytes: defaults.bytes,
        buildMs: defaults.buildMs,
        exactRecall: 1,
        ...defaults.byEf.find((e) => e.efSearch === APP_EF_SEARCH)!,
      },
    ];

    for (const n of TRUNCATIONS) {
      const column = truncatedColumn(n);
      const query = (q: number[]) => ({ ...full(truncateEmbedding(q, n)), column, dimensions: n });
      const exactTruncated = await measure((q) => tx((t) => exactNearest(t, query(q))), truth);
      const built = await build(`bench_${column}_hnsw`, column, "vector_cosine_ops");
      const ann = await measure((q) => tx((t) => annNearest(t, { ...query(q), efSearch: APP_EF_SEARCH })), truth);
      variants.push({
        name: `vector(${n}), truncated, HNSW`,
        bytesPerVector: bytesPerVector("vector", n),
        indexBytes: built.bytes,
        buildMs: built.buildMs,
        exactRecall: exactTruncated.recall,
        ...ann,
      });
      await drop(`bench_${column}_hnsw`);
      log(`truncated to ${n}`);
    }

    const halfQuery = (q: number[]) => ({ ...full(q), column: "half", type: "halfvec" as const });
    const halfExact = await measure((q) => tx((t) => exactNearest(t, halfQuery(q))), truth);
    const halfBuilt = await build("bench_half_hnsw", "half", "halfvec_cosine_ops");
    variants.push({
      name: "halfvec(1536), HNSW",
      bytesPerVector: bytesPerVector("halfvec", DIMENSIONS),
      indexBytes: halfBuilt.bytes,
      buildMs: halfBuilt.buildMs,
      exactRecall: halfExact.recall,
      ...(await measure((q) => tx((t) => annNearest(t, { ...halfQuery(q), efSearch: APP_EF_SEARCH })), truth)),
    });
    await drop("bench_half_hnsw");
    log("halfvec");

    const bitsBuilt = await build("bench_bits_hnsw", "bits", "bit_hamming_ops");
    for (const overfetch of OVERFETCH) {
      const measured = await measure(
        (q) =>
          tx((t) =>
            binaryRescoreNearest(t, {
              table: TABLE,
              bitsColumn: "bits",
              vectorColumn: "embedding",
              dimensions: DIMENSIONS,
              embedding: q,
              k: K,
              overfetch,
              efSearch: APP_EF_SEARCH,
            }),
          ),
        truth,
      );
      variants.push({
        name:
          overfetch === K
            ? "bit(1536), HNSW (Hamming only)"
            : `bit(1536), HNSW, ${overfetch} rescored with vector(1536)`,
        bytesPerVector: bytesPerVector("bit", DIMENSIONS),
        indexBytes: bitsBuilt.bytes,
        buildMs: bitsBuilt.buildMs,
        exactRecall: null,
        ...measured,
      });
    }
    log("bit");

    const tableSize = await tableBytes(db, TABLE);
    const date = new Date().toISOString().slice(0, 10);
    const report = {
      date,
      rows: distinct.length,
      chunks: rows.length,
      queries: queries.length,
      embeddingTokens: tokens,
      k: K,
      appEfSearch: APP_EF_SEARCH,
      exact,
      grid,
      variants,
      tableBytes: tableSize,
    };
    mkdirSync(REPORTS, { recursive: true });
    writeFileSync(join(REPORTS, `${date}.json`), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(REPORTS, `${date}.md`), render(report));
    log(`wrote fixtures/vectors/reports/${date}.md and .json`);
  } finally {
    await db.$client.end();
    await source.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await source.end();
  }
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const ms = (n: number) => n.toFixed(2);
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function render(r: {
  date: string;
  rows: number;
  chunks: number;
  queries: number;
  embeddingTokens: number;
  k: number;
  appEfSearch: number;
  exact: Measured;
  grid: { knobs: HnswKnobs; buildMs: number; bytes: number; byEf: (Measured & { efSearch: number })[] }[];
  variants: {
    name: string;
    bytesPerVector: number;
    indexBytes: number | null;
    buildMs: number | null;
    exactRecall: number | null;
    recall: number;
    medianMs: number;
    p95Ms: number;
  }[];
  tableBytes: number;
}): string {
  const lines = [
    `# Vector bench: ${r.date}`,
    "",
    `${r.rows} distinct chunk embeddings (of ${r.chunks} chunks; text-embedding-3-small, 1,536 dimensions) from the ` +
      `dev corpus, copied to a scratch ` +
      `database. ${r.queries} queries: the golden questions (${r.embeddingTokens} embedding tokens this run; ` +
      `0 means the cache answered). Recall is recall@${r.k} against an exact scan of the full vectors. Latency is ` +
      `one query in its own transaction, \`SET LOCAL\`s included, on a warm cache, local Postgres.`,
    "",
    `Exact scan: median ${ms(r.exact.medianMs)} ms, p95 ${ms(r.exact.p95Ms)} ms.`,
    "",
    "An HNSW build is random (each node draws its layer), and 46 queries are few, so a rerun moves an HNSW recall " +
      "by a few points: read the trends, not the third digit.",
    "",
    "## HNSW knobs: recall@10 (median ms) by ef_search",
    "",
    `| m | ef_construction | build | index | ${r.grid[0].byEf.map((e) => `ef_search ${e.efSearch}`).join(" | ")} |`,
    `|---:|---:|---:|---:|${r.grid[0].byEf.map(() => "---:").join("|")}|`,
    ...r.grid.map(
      (g) =>
        `| ${g.knobs.m} | ${g.knobs.efConstruction} | ${(g.buildMs / 1000).toFixed(1)} s | ${mb(g.bytes)} | ` +
        `${g.byEf.map((e) => `${pct(e.recall)} (${ms(e.medianMs)})`).join(" | ")} |`,
    ),
    "",
    `## Variants (HNSW at m 16, ef_construction 64, ef_search ${r.appEfSearch})`,
    "",
    "Exact recall is the type's own ceiling: an exact scan over that column, against the full vectors' truth.",
    "",
    "| Variant | bytes/vector | index | build | exact recall | recall@10 | median ms | p95 ms |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...r.variants.map(
      (v) =>
        `| ${v.name} | ${v.bytesPerVector} | ${v.indexBytes === null ? "" : mb(v.indexBytes)} | ` +
        `${v.buildMs === null ? "" : `${(v.buildMs / 1000).toFixed(1)} s`} | ` +
        `${v.exactRecall === null ? "" : pct(v.exactRecall)} | ${pct(v.recall)} | ${ms(v.medianMs)} | ${ms(v.p95Ms)} |`,
    ),
    "",
    `Scratch table, every column, TOAST included: ${mb(r.tableBytes)}. An HNSW index stores each vector in its ` +
      "pages, and a page holds 8 KB: one 6,152-byte vector(1536) or vector(1024) fills a page, so those indexes " +
      "are the same size whatever m is; halfvec(1536) fits two, vector(512) three.",
    "",
  ];
  return lines.join("\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
