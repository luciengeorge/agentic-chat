// @vitest-environment node
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Tx } from "@/db/tenant";

import { annNearest, buildHnswIndex, type HnswKnobs, PGVECTOR_DEFAULTS } from "#learn/vectors/hnsw";
import { exactNearest, recallAtK } from "#learn/vectors/recall";
import { createScratchTable, loadScratchTable } from "#learn/vectors/scratch";
import { cosineSimilarity, distinctChunks, goldenQueries, recordedQuery } from "@/core/vectors/recording";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

describe("recallAtK", () => {
  it("is the share of the true top k found in the first k, in any order", () => {
    expect(recallAtK(["a", "b", "x", "y"], ["a", "b", "c", "d"], 4)).toBe(0.5);
    expect(recallAtK(["b", "a"], ["a", "b", "c"], 2), "order doesn't matter, only whether they were found").toBe(1);
  });

  it("looks only at found's first k", () => {
    expect(
      recallAtK(["x", "y", "a", "b"], ["a", "b"], 2),
      "a and b came back 3rd and 4th, outside the first 2: count found's first k only",
    ).toBe(0);
  });

  it("divides by the true neighbours, so returning less never scores more", () => {
    expect(
      recallAtK(["a", "b"], ["a", "b", "c", "d"], 4),
      "2 of the 4 true neighbours: divide by the truth's length, not by how many came back",
    ).toBe(0.5);
    expect(recallAtK([], ["a"], 1)).toBe(0);
    expect(() => recallAtK(["a"], [], 3)).toThrow(RangeError);
  });
});

describe.skipIf(!postgresAvailable)("exact and approximate search over the recorded vectors", () => {
  let t: TestDatabase;
  const rows = distinctChunks();
  const queries = goldenQueries();
  const tx = <T>(fn: (tx: Tx) => Promise<T>) => t.db.transaction(fn);
  const query = (embedding: number[]) => ({
    table: "rec",
    column: "embedding",
    type: "vector" as const,
    dimensions: 1536,
    embedding,
    k: 10,
  });
  const bruteForce = (embedding: number[]) =>
    rows
      .map((row) => ({ id: row.key, similarity: cosineSimilarity(embedding, row.embedding) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 10)
      .map((row) => row.id);
  const build = (knobs: HnswKnobs) =>
    buildHnswIndex(t.db, { name: "rec_hnsw", table: "rec", column: "embedding", ops: "vector_cosine_ops", knobs });
  async function averageRecall(efSearch: number, truth: string[][]) {
    let sum = 0;
    for (const [i, q] of queries.entries()) {
      sum += recallAtK(await tx((t) => annNearest(t, { ...query(q.embedding), efSearch })), truth[i], 10);
    }
    return sum / queries.length;
  }

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
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  });

  it("finds the true top 10 for every golden question, even where the planner would walk the index", async () => {
    // A coarse graph and a narrow search: answer from it, and you get its mistakes.
    await build({ m: 4, efConstruction: 16 });
    for (const q of queries) {
      const found = await tx(async (t) => {
        // What a planner does on a big table. On 428 rows it would scan anyway, and hide the mistake.
        await t.execute(sql`SET LOCAL enable_seqscan = off`);
        await t.execute(sql`SET LOCAL hnsw.ef_search = 10`);
        return exactNearest(t, query(q.embedding));
      });
      expect(
        found,
        `${q.id}: this isn't the true top 10, so it came from the HNSW graph: switch index scans off`,
      ).toEqual(bruteForce(q.embedding));
    }
  });

  it("the worked example: a coarse graph at ef_search 10 misses true neighbours, a wider walk or a denser graph finds them", async () => {
    const truth: string[][] = [];
    for (const q of queries) truth.push(await tx((t) => exactNearest(t, query(q.embedding))));
    expect(truth[0]).toEqual(bruteForce(recordedQuery("kpc-2026-0142-owner").embedding));

    await build({ m: 4, efConstruction: 16 });
    const coarse10 = await averageRecall(10, truth);
    const coarse100 = await averageRecall(100, truth);
    await build(PGVECTOR_DEFAULTS);
    const default40 = await averageRecall(40, truth);

    // HNSW builds are random (each vector draws its layer), so these move a few points between runs: about 87%,
    // 99% and 100% on 428 vectors. On the full corpus's 5,637 the bench measured 35.9% at m 4 and 75.9% at the
    // defaults, at ef_search 40.
    expect(coarse10, "m 4 at ef_search 10 should miss some of the true top 10").toBeLessThan(0.95);
    expect(coarse100).toBeGreaterThan(coarse10);
    expect(coarse100).toBeGreaterThanOrEqual(0.95);
    expect(default40).toBeGreaterThanOrEqual(0.97);
  }, 60_000);
});
