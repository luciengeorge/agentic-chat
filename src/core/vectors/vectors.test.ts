// @vitest-environment node

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Tx } from "@/db/tenant";

import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { annNearest, buildHnswIndex, hnswIndexSql, PGVECTOR_DEFAULTS } from "./hnsw";
import { binaryQuantize, binaryRescoreNearest, hammingDistance } from "./quantize";
import { exactNearest, recallAtK } from "./recall";
import { createScratchTable, loadScratchTable, truncatedColumn } from "./scratch";
import { bytesPerVector, relationBytes } from "./sizing";
import { truncateEmbedding } from "./truncate";

// A seeded generator (mulberry32), so every run builds the same vectors.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const D = 32;
const N = 400;
const next = random(7);
const unit = (v: number[]) => v.map((x) => x / Math.hypot(...v));
const vectors = Array.from({ length: N }, () => unit(Array.from({ length: D }, () => next() * 2 - 1)));
const ROWS = vectors.map((embedding, i) => ({ id: `r${String(i).padStart(3, "0")}`, embedding }));
const QUERIES = Array.from({ length: 10 }, () => unit(Array.from({ length: D }, () => next() * 2 - 1)));

const cosine = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const bruteForce = (query: number[], k: number) =>
  ROWS.map((row) => ({ id: row.id, distance: 1 - cosine(query, row.embedding) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k)
    .map((row) => row.id);

describe("truncateEmbedding", () => {
  it("keeps the prefix and scales it back to length 1", () => {
    const short = truncateEmbedding([0.6, 0.0, 0.8], 2);
    // [0.6, 0] has length 0.6, so it becomes [1, 0].
    expect(short).toEqual([1, 0]);
    const half = truncateEmbedding(vectors[0], 16);
    expect(Math.hypot(...half)).toBeCloseTo(1, 12);
    expect(half[3] / half[0]).toBeCloseTo(vectors[0][3] / vectors[0][0], 12);
  });

  it("refuses to keep more dimensions than there are", () => {
    expect(() => truncateEmbedding([1, 0], 3)).toThrow(RangeError);
  });
});

describe("binaryQuantize and hammingDistance", () => {
  it("keeps one bit per dimension, 1 above zero, and counts differing bits", () => {
    expect(binaryQuantize([0.3, -0.1, 0, 2])).toBe("1001");
    expect(hammingDistance("1001", "1100")).toBe(2);
  });
});

describe("recallAtK", () => {
  it("is the share of the true top k found in the first k", () => {
    expect(recallAtK(["a", "b", "x", "y"], ["a", "b", "c", "d"], 4)).toBe(0.5);
    expect(recallAtK(["b", "a"], ["a", "b", "c"], 2)).toBe(1);
  });
});

describe("hnswIndexSql", () => {
  it("puts the build knobs in WITH and checks them", () => {
    expect(
      hnswIndexSql({
        name: "i",
        table: "t",
        column: "e",
        ops: "vector_cosine_ops",
        knobs: { m: 8, efConstruction: 32 },
      }),
    ).toBe("CREATE INDEX i ON t USING hnsw (e vector_cosine_ops) WITH (m = 8, ef_construction = 32)");
    // ef_construction below 2 * m can't build a good graph; pgvector refuses it too.
    expect(() =>
      hnswIndexSql({
        name: "i",
        table: "t",
        column: "e",
        ops: "vector_cosine_ops",
        knobs: { m: 16, efConstruction: 16 },
      }),
    ).toThrow(RangeError);
  });
});

describe("bytesPerVector", () => {
  it("is 8 bytes of header plus 4, 2 or 1/8 bytes per dimension", () => {
    expect(bytesPerVector("vector", 1536)).toBe(6152);
    expect(bytesPerVector("halfvec", 1536)).toBe(3080);
    expect(bytesPerVector("bit", 1536)).toBe(200);
  });
});

describe.skipIf(!postgresAvailable)("vectors in Postgres", () => {
  let t: TestDatabase;
  const table = { name: "scratch_vectors", dimensions: D, truncations: [8, 16] };
  const tx = <T>(fn: (tx: Tx) => Promise<T>) => t.db.transaction(fn);
  const query = (embedding: number[], k = 10) => ({
    table: table.name,
    column: "embedding",
    type: "vector" as const,
    dimensions: D,
    embedding,
    k,
  });

  beforeAll(async () => {
    t = await createTestDatabase({ migrated: false });
    await t.sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await createScratchTable(t.db, table);
    await loadScratchTable(t.db, table, ROWS);
    await buildHnswIndex(t.db, {
      name: "scratch_hnsw",
      table: table.name,
      column: "embedding",
      ops: "vector_cosine_ops",
      knobs: { m: 8, efConstruction: 32 },
    });
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  });

  it("stores the build knobs on the index", async () => {
    const [row] = await t.sql`SELECT reloptions FROM pg_class WHERE relname = 'scratch_hnsw'`;
    expect(row.reloptions).toEqual(["m=8", "ef_construction=32"]);
  });

  it("exactNearest scans every row and matches a brute-force sort", async () => {
    const plan = await tx(async (t) => {
      await t.execute(sql`SET LOCAL enable_indexscan = off`);
      return t.execute<{ "QUERY PLAN": string }>(
        sql.raw(
          `EXPLAIN SELECT id FROM scratch_vectors ORDER BY embedding <=> '${JSON.stringify(QUERIES[0])}' LIMIT 10`,
        ),
      );
    });
    expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toContain("Seq Scan");
    for (const q of QUERIES) expect(await tx((t) => exactNearest(t, query(q)))).toEqual(bruteForce(q, 10));
  });

  it("annNearest walks the HNSW graph: ef_search caps the rows, and a wide search finds the true neighbours", async () => {
    // pgvector's HNSW scan hands back at most ef_search rows, whatever the LIMIT.
    expect(await tx((t) => annNearest(t, { ...query(QUERIES[0]), efSearch: 5 }))).toHaveLength(5);
    let recall = 0;
    for (const q of QUERIES) {
      const found = await tx((t) => annNearest(t, { ...query(q), efSearch: 200 }));
      recall += recallAtK(found, bruteForce(q, 10), 10) / QUERIES.length;
    }
    expect(recall).toBeGreaterThanOrEqual(0.95);
  });

  it("stores halfvec, bit and the truncated prefixes as pgvector computes them", async () => {
    const [row] = await t.sql<{ half: number; bits: number; full: number; same: boolean; prefix: string }[]>`
      SELECT pg_column_size(embedding::halfvec) AS half, pg_column_size(binary_quantize(embedding)) AS bits,
        pg_column_size(embedding) AS full,
        bits = binary_quantize(embedding) AS same, e8::text AS prefix
      FROM scratch_vectors WHERE id = 'r000'`;
    expect([row.full, row.half, row.bits]).toEqual([
      bytesPerVector("vector", D),
      bytesPerVector("halfvec", D),
      bytesPerVector("bit", D),
    ]);
    expect(row.same).toBe(true);
    expect(JSON.parse(row.prefix)[0]).toBeCloseTo(truncateEmbedding(ROWS[0].embedding, 8)[0], 5);
    const [{ bits }] = await t.sql`SELECT bits::text FROM scratch_vectors WHERE id = 'r000'`;
    expect(bits).toBe(binaryQuantize(ROWS[0].embedding));
    expect(truncatedColumn(8)).toBe("e8");
  });

  it("binary search with rescoring: over-fetching every row gives the exact answer, bits alone don't", async () => {
    await buildHnswIndex(t.db, {
      name: "scratch_bits_hnsw",
      table: table.name,
      column: "bits",
      ops: "bit_hamming_ops",
      knobs: PGVECTOR_DEFAULTS,
    });
    const rescore = (q: number[], overfetch: number) =>
      tx((t) =>
        binaryRescoreNearest(t, {
          table: table.name,
          bitsColumn: "bits",
          vectorColumn: "embedding",
          dimensions: D,
          embedding: q,
          k: 10,
          overfetch,
          efSearch: 40,
        }),
      );
    let narrow = 0;
    let wide = 0;
    for (const q of QUERIES) {
      const truth = bruteForce(q, 10);
      narrow += recallAtK(await rescore(q, 10), truth, 10) / QUERIES.length;
      wide += recallAtK(await rescore(q, N), truth, 10) / QUERIES.length;
    }
    expect(wide).toBeGreaterThanOrEqual(0.95);
    expect(narrow).toBeLessThan(wide);
  });

  it("measures an index's size on disk, and a bit index is smaller than a full one", async () => {
    const full = await relationBytes(t.db, "scratch_hnsw");
    const bits = await relationBytes(t.db, "scratch_bits_hnsw");
    expect(full).toBeGreaterThan(0);
    expect(bits).toBeLessThan(full);
  });
});
