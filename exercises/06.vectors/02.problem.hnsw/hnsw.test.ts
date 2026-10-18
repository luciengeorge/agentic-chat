// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildHnswIndex, hnswIndexSql, PGVECTOR_DEFAULTS } from "#learn/vectors/hnsw";
import { createScratchTable, loadScratchTable } from "#learn/vectors/scratch";
import { distinctChunks } from "@/core/vectors/recording";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

const index = (knobs: { m: number; efConstruction: number }) =>
  ({ name: "rec_hnsw", table: "rec", column: "embedding", ops: "vector_cosine_ops", knobs }) as const;

describe("hnswIndexSql", () => {
  it("builds over the column with its operator class, and puts m and ef_construction in WITH", () => {
    expect(hnswIndexSql(index(PGVECTOR_DEFAULTS))).toBe(
      "CREATE INDEX rec_hnsw ON rec USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)",
    );
    expect(
      hnswIndexSql({
        name: "rec_bits",
        table: "rec",
        column: "bits",
        ops: "bit_hamming_ops",
        knobs: PGVECTOR_DEFAULTS,
      }),
    ).toBe("CREATE INDEX rec_bits ON rec USING hnsw (bits bit_hamming_ops) WITH (m = 16, ef_construction = 64)");
  });

  it("refuses knobs that can't build a sound graph, before writing any SQL", () => {
    for (const knobs of [
      { m: 1, efConstruction: 64 },
      { m: 101, efConstruction: 400 },
      { m: 8.5, efConstruction: 64 },
      { m: 16, efConstruction: 1001 },
    ]) {
      expect(() => hnswIndexSql(index(knobs)), `m ${knobs.m}, ef_construction ${knobs.efConstruction}`).toThrow(
        RangeError,
      );
    }
    expect(
      () => hnswIndexSql(index({ m: 16, efConstruction: 31 })),
      "ef_construction 31 is below 2 × m (32): the build couldn't choose 2 × m links on the bottom layer",
    ).toThrow(RangeError);
    expect(hnswIndexSql(index({ m: 16, efConstruction: 32 }))).toContain("ef_construction = 32");
  });

  it("refuses names that would need quoting", () => {
    expect(
      () => hnswIndexSql({ ...index(PGVECTOR_DEFAULTS), table: "rec; DROP TABLE chunks" }),
      "pass every name through identifier(), which refuses anything that isn't a plain name",
    ).toThrow(RangeError);
  });
});

describe.skipIf(!postgresAvailable)("building the index", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase({ migrated: false });
    await t.sql`CREATE EXTENSION IF NOT EXISTS vector`;
    const table = { name: "rec", dimensions: 1536, truncations: [] };
    await createScratchTable(t.db, table);
    await loadScratchTable(
      t.db,
      table,
      distinctChunks().map((chunk) => ({ id: chunk.key, embedding: chunk.embedding })),
    );
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  });

  it("stores m and ef_construction on the index pgvector builds from the 428 recorded vectors", async () => {
    await buildHnswIndex(t.db, index({ m: 8, efConstruction: 32 }));
    const [row] = await t.sql`SELECT reloptions FROM pg_class WHERE relname = 'rec_hnsw'`;
    expect(row.reloptions).toEqual(["m=8", "ef_construction=32"]);
  });
});
