/**
 * The vectors lab's server side (section 06): the bench's variants, run through `#learn/vectors/*` so they show the
 * learner's code while a step of section 06 is active. The vectors are copied into a scratch database of their own
 * (`ac_vectors_lab`), never the app's tables, from the dev corpus or from the committed recording; the queries are
 * the recorded golden questions. Server only, dev only.
 */
import postgres from "postgres";

import type { Tx } from "@/db/tenant";

import { annNearest, buildHnswIndex, PGVECTOR_DEFAULTS, type VectorOps } from "#learn/vectors/hnsw";
import { binaryRescoreNearest } from "#learn/vectors/quantize";
import { exactNearest, recallAtK } from "#learn/vectors/recall";
import { createScratchTable, loadScratchTable, truncatedColumn } from "#learn/vectors/scratch";
import { bytesPerVector, relationBytes } from "#learn/vectors/sizing";
import { truncateEmbedding } from "#learn/vectors/truncate";
import { distinctChunks, goldenQueries, RECORDED_MODEL } from "@/core/vectors/recording";
import { createDb, type Db } from "@/db/create";

export const LAB_DATABASE = "ac_vectors_lab";
const TABLE = "lab_vectors";
const DIMENSIONS = 1536;
const TRUNCATIONS = [256, 512, 1024];
const K = 10;
const APP_EF_SEARCH = 100;

export type VectorSource = "corpus" | "recording";

export interface VectorVariant {
  name: string;
  kind: "exact" | "hnsw" | "truncated" | "halfvec" | "bit";
  bytesPerVector: number;
  /** The index's size on disk; null for the exact scan, which has none. */
  indexBytes: number | null;
  recall: number;
  medianMs: number;
}

export interface VectorLabRun {
  source: VectorSource;
  rows: number;
  queries: number;
  variants: VectorVariant[];
  /** What the learner's code threw, if it did; the variants measured before it stay. */
  error: string | null;
}

/** The dev corpus's current chunk vectors, one per distinct vector, or the recording's 428. */
async function sourceRows(adminUrl: string, source: VectorSource): Promise<{ id: string; embedding: number[] }[]> {
  if (source === "recording") return distinctChunks().map((chunk) => ({ id: chunk.key, embedding: chunk.embedding }));
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql<{ id: string; embedding: string }[]>`
      SELECT c.id::text AS id, c.embedding::text AS embedding
      FROM chunks c JOIN documents doc ON doc.id = c.document_id AND doc.version = c.document_version
      WHERE doc.status = 'ready' AND c.embedding_model_version = ${RECORDED_MODEL}
      ORDER BY c.id`;
    const distinct = [...new Map(rows.map((row) => [row.embedding, row])).values()];
    return distinct.map((row) => ({ id: row.id, embedding: JSON.parse(row.embedding) as number[] }));
  } finally {
    await sql.end();
  }
}

async function scratchDatabase(adminUrl: string, database: string): Promise<Db> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database)) throw new RangeError(`not a database name: ${database}`);
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const [exists] = await sql`SELECT 1 FROM pg_database WHERE datname = ${database}`;
    if (!exists) await sql.unsafe(`CREATE DATABASE ${database}`);
  } finally {
    await sql.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  const db = createDb(url.toString());
  await db.$client`CREATE EXTENSION IF NOT EXISTS vector`;
  return db;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

let running: Promise<unknown> = Promise.resolve();

/** One run at a time: two would rebuild the same scratch table under each other. */
export function runVectorLab(
  adminUrl: string,
  source: VectorSource,
  database: string = LAB_DATABASE,
): Promise<VectorLabRun> {
  const run = running.then(() => measureAll(adminUrl, source, database));
  running = run.catch(() => {});
  return run;
}

async function measureAll(adminUrl: string, source: VectorSource, database: string): Promise<VectorLabRun> {
  const rows = await sourceRows(adminUrl, source);
  const queries = goldenQueries().map((q) => q.embedding);
  const result: VectorLabRun = { source, rows: rows.length, queries: queries.length, variants: [], error: null };
  if (rows.length === 0) {
    result.error = `no ${RECORDED_MODEL} vectors in the dev database; run \`pnpm db:embed\`, or pick the recording`;
    return result;
  }
  const db = await scratchDatabase(adminUrl, database);
  const tx = <T>(fn: (tx: Tx) => Promise<T>) => db.transaction(fn);
  const full = (embedding: number[]) => ({
    table: TABLE,
    column: "embedding",
    type: "vector" as const,
    dimensions: DIMENSIONS,
    embedding,
    k: K,
  });

  try {
    await createScratchTable(db, { name: TABLE, dimensions: DIMENSIONS, truncations: TRUNCATIONS });
    await loadScratchTable(db, { name: TABLE, dimensions: DIMENSIONS, truncations: TRUNCATIONS }, rows);

    const truth: string[][] = [];
    for (const q of queries) truth.push(await tx((t) => exactNearest(t, full(q))));
    /** Every query once to warm the cache, then again timed, each scored against the exact top 10. */
    const measure = async (search: (q: number[]) => Promise<string[]>) => {
      for (const q of queries) await search(q);
      const ms: number[] = [];
      let recall = 0;
      for (const [i, q] of queries.entries()) {
        const started = performance.now();
        const found = await search(q);
        ms.push(performance.now() - started);
        recall += recallAtK(found, truth[i], K) / queries.length;
      }
      return { recall, medianMs: median(ms) };
    };
    const build = async (name: string, column: string, ops: VectorOps) => {
      await buildHnswIndex(db, { name, table: TABLE, column, ops, knobs: PGVECTOR_DEFAULTS });
      return relationBytes(db, name);
    };
    const add = (variant: VectorVariant) => result.variants.push(variant);

    add({
      name: "vector(1536), exact scan",
      kind: "exact",
      bytesPerVector: bytesPerVector("vector", DIMENSIONS),
      indexBytes: null,
      ...(await measure((q) => tx((t) => exactNearest(t, full(q))))),
    });

    const fullBytes = await build("lab_hnsw", "embedding", "vector_cosine_ops");
    for (const efSearch of [10, 40, 100, 200]) {
      add({
        name: `vector(1536), HNSW, ef_search ${efSearch}`,
        kind: "hnsw",
        bytesPerVector: bytesPerVector("vector", DIMENSIONS),
        indexBytes: fullBytes,
        ...(await measure((q) => tx((t) => annNearest(t, { ...full(q), efSearch })))),
      });
    }
    await db.$client.unsafe("DROP INDEX lab_hnsw");

    for (const n of TRUNCATIONS) {
      const column = truncatedColumn(n);
      const bytes = await build(`lab_${column}_hnsw`, column, "vector_cosine_ops");
      add({
        name: `vector(${n}), truncated, HNSW`,
        kind: "truncated",
        bytesPerVector: bytesPerVector("vector", n),
        indexBytes: bytes,
        ...(await measure((q) =>
          tx((t) =>
            annNearest(t, {
              ...full(truncateEmbedding(q, n)),
              column,
              dimensions: n,
              efSearch: APP_EF_SEARCH,
            }),
          ),
        )),
      });
      await db.$client.unsafe(`DROP INDEX lab_${column}_hnsw`);
    }

    const halfBytes = await build("lab_half_hnsw", "half", "halfvec_cosine_ops");
    add({
      name: "halfvec(1536), HNSW",
      kind: "halfvec",
      bytesPerVector: bytesPerVector("halfvec", DIMENSIONS),
      indexBytes: halfBytes,
      ...(await measure((q) =>
        tx((t) => annNearest(t, { ...full(q), column: "half", type: "halfvec", efSearch: APP_EF_SEARCH })),
      )),
    });
    await db.$client.unsafe("DROP INDEX lab_half_hnsw");

    const bitBytes = await build("lab_bits_hnsw", "bits", "bit_hamming_ops");
    for (const overfetch of [K, 40, 200]) {
      add({
        name: overfetch === K ? "bit(1536), Hamming only" : `bit(1536), ${overfetch} rescored`,
        kind: "bit",
        bytesPerVector: bytesPerVector("bit", DIMENSIONS),
        indexBytes: bitBytes,
        ...(await measure((q) =>
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
        )),
      });
    }
    await db.$client.unsafe("DROP INDEX lab_bits_hnsw");
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    await db.$client.end();
  }
  return result;
}
