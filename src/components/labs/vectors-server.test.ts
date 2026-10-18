// @vitest-environment node
import postgres from "postgres";
import { afterAll, describe, expect, it, inject } from "vitest";

import { postgresAvailable } from "@/db/testing";

import { runVectorLab } from "./vectors-server";

describe.skipIf(!postgresAvailable)("the vectors lab", () => {
  const database = `ac_vectors_lab_test_${Math.random().toString(36).slice(2, 8)}`;
  const adminUrl = () => inject("postgres")!.adminUrl;

  afterAll(async () => {
    if (!postgresAvailable) return;
    const sql = postgres(adminUrl(), { max: 1, onnotice: () => {} });
    await sql.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await sql.end();
  });

  it("measures every variant over the recording, against an exact scan", async () => {
    const run = await runVectorLab(adminUrl(), "recording", database);
    expect(run.error).toBeNull();
    expect([run.rows, run.queries]).toEqual([428, 46]);
    expect(run.variants.map((v) => v.kind)).toEqual([
      "exact",
      "hnsw",
      "hnsw",
      "hnsw",
      "hnsw",
      "truncated",
      "truncated",
      "truncated",
      "halfvec",
      "bit",
      "bit",
      "bit",
    ]);
    const byName = Object.fromEntries(run.variants.map((v) => [v.name, v]));
    expect(byName["vector(1536), exact scan"].recall).toBeCloseTo(1, 10);
    expect(byName["vector(1536), HNSW, ef_search 200"].recall).toBeGreaterThanOrEqual(0.97);
    expect(byName["vector(256), truncated, HNSW"].recall).toBeLessThan(0.85);
    expect(byName["bit(1536), Hamming only"].recall).toBeLessThan(byName["bit(1536), 200 rescored"].recall);
    expect(byName["bit(1536), 200 rescored"].indexBytes!).toBeLessThan(
      byName["vector(1536), HNSW, ef_search 40"].indexBytes! / 10,
    );
  }, 120_000);
});
