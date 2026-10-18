// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Tx } from "@/db/tenant";

import { buildHnswIndex, PGVECTOR_DEFAULTS, type VectorOps } from "#learn/vectors/hnsw";
import { binaryRescoreNearest } from "#learn/vectors/quantize";
import { recallAtK } from "#learn/vectors/recall";
import { createScratchTable, loadScratchTable } from "#learn/vectors/scratch";
import { bytesPerVector, relationBytes } from "#learn/vectors/sizing";
import { cosineSimilarity, distinctChunks, goldenQueries } from "@/core/vectors/recording";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

const PAGE = 8192;

describe("bytesPerVector", () => {
  it("is an 8-byte header plus 4, 2 or 1/8 bytes a dimension", () => {
    expect(bytesPerVector("vector", 1536), "8 bytes of header, then 4 a dimension").toBe(6152);
    expect(bytesPerVector("halfvec", 1536), "8 bytes of header, then 2 a dimension").toBe(3080);
    expect(bytesPerVector("bit", 1536), "8 bytes of header, then one bit a dimension: 192 bytes").toBe(200);
    expect(bytesPerVector("vector", 256)).toBe(1032);
    expect(bytesPerVector("bit", 10), "10 bits need 2 whole bytes").toBe(10);
  });
});

describe.skipIf(!postgresAvailable)("halfvec, bit and rescoring over the recorded vectors", () => {
  let t: TestDatabase;
  const rows = distinctChunks();
  const queries = goldenQueries();
  const tx = <T>(fn: (tx: Tx) => Promise<T>) => t.db.transaction(fn);
  const truth = (embedding: number[], k = 10) =>
    rows
      .map((row) => ({ id: row.key, similarity: cosineSimilarity(embedding, row.embedding) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k)
      .map((row) => row.id);
  const rescore = (embedding: number[], options: { k?: number; overfetch: number; efSearch?: number }) =>
    tx((t) =>
      binaryRescoreNearest(t, {
        table: "rec",
        bitsColumn: "bits",
        vectorColumn: "embedding",
        dimensions: 1536,
        embedding,
        k: options.k ?? 10,
        overfetch: options.overfetch,
        efSearch: options.efSearch ?? 40,
      }),
    );
  async function averageRecall(overfetch: number) {
    let sum = 0;
    for (const q of queries) sum += recallAtK(await rescore(q.embedding, { overfetch }), truth(q.embedding), 10);
    return sum / queries.length;
  }
  const build = (name: string, column: string, ops: VectorOps) =>
    buildHnswIndex(t.db, { name, table: "rec", column, ops, knobs: PGVECTOR_DEFAULTS });

  beforeAll(async () => {
    t = await createTestDatabase({ migrated: false });
    await t.sql`CREATE EXTENSION IF NOT EXISTS vector`;
    const table = { name: "rec", dimensions: 1536, truncations: [] };
    await createScratchTable(t.db, table);
    await loadScratchTable(
      t.db,
      table,
      rows.map((row) => ({ id: row.key, embedding: row.embedding })),
    );
    await build("rec_full", "embedding", "vector_cosine_ops");
    await build("rec_half", "half", "halfvec_cosine_ops");
    await build("rec_bits", "bits", "bit_hamming_ops");
  }, 120_000);

  afterAll(async () => {
    await t?.drop();
  });

  it("matches the size Postgres gives a real vector in each type", async () => {
    // Values made by a cast, so they're whole: a stored one over about 2 KB sits out of line (TOAST), where
    // pg_column_size leaves out its 4-byte length word.
    const [row] = await t.sql<{ full: number; half: number; bits: number }[]>`
      SELECT pg_column_size(half::vector(1536)) AS full, pg_column_size(embedding::halfvec(1536)) AS half,
        pg_column_size(binary_quantize(embedding)) AS bits
      FROM rec LIMIT 1`;
    expect([row.full, row.half, row.bits]).toEqual([
      bytesPerVector("vector", 1536),
      bytesPerVector("halfvec", 1536),
      bytesPerVector("bit", 1536),
    ]);
  });

  it("refuses an over-fetch below k", async () => {
    const failure = await rescore(rows[0].embedding, { k: 10, overfetch: 5 }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure, "5 candidates can't give a top 10: throw a RangeError when overfetch < k").toBeInstanceOf(
      RangeError,
    );
  });

  it("asks the HNSW scan for every candidate it over-fetches", async () => {
    const found = await rescore(queries[0].embedding, { k: 200, overfetch: 200, efSearch: 40 });
    expect(
      found.length,
      "an HNSW scan hands back at most ef_search rows (40 here): raise hnsw.ef_search to the over-fetch",
    ).toBe(200);
  });

  it("gives exactly the exact answer when it rescores every row", async () => {
    for (const q of queries) {
      expect(
        await rescore(q.embedding, { overfetch: rows.length }),
        `${q.id}: with every row a candidate, sorting by the full vectors' cosine distance is the exact search`,
      ).toEqual(truth(q.embedding));
    }
  });

  it("the worked example: bits alone miss, 200 rescored find nearly all, from an index a 15th the size", async () => {
    const bitsAlone = await averageRecall(10);
    const rescored = await averageRecall(200);
    // About 81% and 100% on 428 vectors (they move a little between builds); 68.3% and 91.7% on the full corpus.
    expect(bitsAlone, "bits alone should miss some of the true top 10").toBeLessThan(0.9);
    expect(rescored, "200 candidates rescored by their full vectors should find nearly all").toBeGreaterThanOrEqual(
      0.98,
    );

    // A page holds 8 KB: one 6,152-byte vector, two 3,080-byte halfvecs, dozens of 200-byte bit strings.
    const pages = async (name: string) => (await relationBytes(t.db, name)) / PAGE;
    expect(Math.floor(PAGE / bytesPerVector("vector", 1536))).toBe(1);
    expect(await pages("rec_full"), "one page per vector, plus the metadata page").toBe(rows.length + 1);
    expect(await pages("rec_half")).toBeLessThanOrEqual(rows.length / 2 + 2);
    expect(await pages("rec_bits")).toBeLessThan(rows.length / 15);
  });
});
