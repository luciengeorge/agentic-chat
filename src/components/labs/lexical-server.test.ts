// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Tx } from "@/db/tenant";

import { hashingEmbedder } from "#learn/embed/fake";
import { recordedQuery } from "@/core/vectors/recording";
import { type LoadedCorpus, loadRecordedCorpus } from "@/core/vectors/testing";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { labQuestions, type LexicalLabDeps, rankings } from "./lexical-server";

describe.skipIf(!postgresAvailable)("the lexical lab", () => {
  let t: TestDatabase;
  let corpus: LoadedCorpus;
  let deps: LexicalLabDeps;
  const LEO = randomUUID();
  const MSA = "/Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf";

  beforeAll(async () => {
    t = await createTestDatabase();
    corpus = await loadRecordedCorpus(t.db);
    const kestrel = corpus.tenants.kestrel;
    await t.sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, enabled, synced_at)
                VALUES (${LEO}, ${kestrel}, 'user', ${LEO}, 'leo.martin', 'Leo Martin', true, now())`;
    // Leo reads every Kestrel document but the Exec folder's.
    for (const [path, id] of corpus.documentIds) {
      const [{ tenant_id: tenant }] = await t.sql`SELECT tenant_id FROM documents WHERE id = ${id}`;
      if (tenant !== kestrel || path.startsWith("/Exec/")) continue;
      await t.sql`INSERT INTO document_acl (tenant_id, document_id, principal_id, effect, acl_version)
                  VALUES (${kestrel}, ${id}, ${LEO}, 'allow', 1)`;
    }
    deps = {
      withTenant: <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => withTenantOn(t.appDb, tenantId, fn),
      embedder: hashingEmbedder(1536),
    };
  }, 120_000);

  afterAll(async () => {
    await t?.drop();
  });

  it("ranks a recorded question three ways, with each chunk's place in every list", async () => {
    const { question } = recordedQuery("kpc-2026-0142-owner");
    const result = await rankings(deps, { tenantId: corpus.tenants.kestrel, userId: LEO }, question);
    expect(result.embedding).toEqual({ source: "recording", version: "text-embedding-3-small@1536" });
    expect(result.bm25[0].title).toBe("KPC-2026-0142 Ashgrove MSA (executed).pdf");
    expect(result.bm25[0].ranks.bm25).toBe(1);
    expect(result.vector.length).toBe(10);
    const msa = result.fused.find((chunk) => chunk.id === corpus.chunkIds.get(`${MSA}#0`))!;
    expect(msa.ranks).toMatchObject({ bm25: 1, vector: 10 });
    expect(msa.score).toBeCloseTo(1 / 61 + 1 / 70, 10);
    const titles = [...result.bm25, ...result.vector, ...result.fused].map((chunk) => chunk.title);
    expect(titles.some((title) => title.startsWith("Project Heron"))).toBe(false);
  });

  it("embeds a question the recording doesn't hold, and finds no vectors of another model", async () => {
    const result = await rankings(deps, { tenantId: corpus.tenants.kestrel, userId: LEO }, "Ashgrove exit fee");
    expect(result.embedding).toEqual({ source: "embedder", version: "fake-hashing-v1@1536" });
    expect(result.vector).toEqual([]);
    expect(result.bm25.length).toBeGreaterThan(0);
  });

  it("offers the viewer's tenant's recorded questions", () => {
    expect(labQuestions("kestrel")).toContain("KPC-2026-0142");
    expect(labQuestions("harbour")).toHaveLength(4);
  });
});
