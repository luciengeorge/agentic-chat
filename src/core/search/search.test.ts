// @vitest-environment node

import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashingEmbedder } from "#learn/embed/fake";
import { chunks, documents } from "@/db/schema";
import { type Tx, withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { lexicalSearch } from "./lexical";
import { uuidArray } from "./sql";
import { vectorSearch } from "./vector";

const embedder = hashingEmbedder(1536);
// A crowd of near-identical texts in one tenant, a few in the other: the nearest neighbours of a crowd text are
// almost all the crowd's.
const CROWD = 1200;
const FEW = 30;

describe.skipIf(!postgresAvailable)("search over chunks", () => {
  let t: TestDatabase;
  let big: string;
  let small: string;
  const docs: Record<string, string> = {};
  const inTenant = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => withTenantOn(t.appDb, tenantId, fn);

  async function addChunks(tenantId: string, texts: string[]) {
    const documentId = randomUUID();
    docs[tenantId] = documentId;
    await t.db.insert(documents).values({
      id: documentId,
      tenantId,
      source: "test",
      externalId: documentId,
      title: "t",
      path: "/t",
      mimeType: "text/markdown",
      version: 1,
      sourceVersion: "1",
      contentHash: "x",
      status: "ready",
    });
    const vectors = await embedder.embed(texts);
    for (let i = 0; i < texts.length; i += 200) {
      await t.db.insert(chunks).values(
        texts.slice(i, i + 200).map((text, j) => ({
          tenantId,
          documentId,
          documentVersion: 1,
          ordinal: i + j,
          text,
          tokenCount: 5,
          embedding: vectors[i + j],
          embeddingModelVersion: embedder.version,
        })),
      );
    }
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: big }, { id: small }] = await t.sql`
      INSERT INTO organization (name, slug, created_at)
      VALUES ('Big', 'big', now()), ('Small', 'small', now()) RETURNING id`;
    await addChunks(
      big,
      Array.from({ length: CROWD }, (_, i) => `settlement report merchant payout batch ${i}`),
    );
    await addChunks(small, [
      "Contract KPC-2026-0142 with Ashgrove: payment within 30 days of invoice",
      ...Array.from({ length: FEW - 1 }, (_, i) => `clinic rota week ${i} payout`),
    ]);
  }, 120_000);

  afterAll(async () => {
    await t?.drop();
  });

  describe("vectorSearch", () => {
    const query = "settlement report merchant payout batch";

    it("returns `limit` rows of a small tenant through HNSW, thanks to the iterative scan", async () => {
      const [vector] = await embedder.embed([query]);
      const hits = await inTenant(small, async (tx) => {
        // Make the planner take the HNSW index, as it would at scale: here it would sort the small set exactly.
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
        await tx.execute(sql`SET LOCAL enable_sort = off`);
        const plan = await tx.execute<{ "QUERY PLAN": string }>(sql`
          EXPLAIN SELECT id FROM chunks
          WHERE embedding_model_version = ${embedder.version} AND document_id = ANY(${uuidArray([docs[small]])})
          ORDER BY embedding <=> ${JSON.stringify(vector)}::vector LIMIT 20`);
        expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toContain("chunks_embedding_hnsw_idx");
        return vectorSearch(tx, vector, {
          documentIds: [docs[small]],
          modelVersion: embedder.version,
          limit: 20,
          efSearch: 20,
        });
      });
      // Without the iterative scan, HNSW hands back its 20 nearest, nearly all the big tenant's, and RLS and the
      // ACL filter drop them: the small tenant would get almost nothing.
      expect(hits).toHaveLength(20);
      expect(hits.map((hit) => hit.score)).toEqual(hits.map((hit) => hit.score).sort((a, b) => b - a));
    });

    it("compares only vectors of the same model version", async () => {
      const [vector] = await embedder.embed([query]);
      const hits = await inTenant(big, (tx) =>
        vectorSearch(tx, vector, { documentIds: [docs[big]], modelVersion: "other@1536", limit: 5 }),
      );
      expect(hits).toEqual([]);
    });

    it("returns nothing for no documents", async () => {
      const [vector] = await embedder.embed([query]);
      expect(
        await inTenant(big, (tx) => vectorSearch(tx, vector, { documentIds: [], modelVersion: "x", limit: 5 })),
      ).toEqual([]);
    });
  });

  describe("lexicalSearch", () => {
    it("ranks an identifier's chunk first", async () => {
      const hits = await inTenant(small, (tx) =>
        lexicalSearch(tx, "payment terms for KPC-2026-0142", { documentIds: [docs[small]], limit: 5 }),
      );
      const [first] = await t.sql`SELECT text FROM chunks WHERE id = ${hits[0].id}`;
      expect(first.text).toContain("KPC-2026-0142");
      expect(hits[0].score).toBeGreaterThan(hits[1]?.score ?? 0);
    });

    it("keeps to the pre-filter's documents and the tenant", async () => {
      // "payout" is in both tenants' chunks.
      const search = (tenantId: string, documentIds: string[]) =>
        inTenant(tenantId, (tx) => lexicalSearch(tx, "payout", { documentIds, limit: 5 }));
      expect(await search(small, [docs[small]])).not.toEqual([]);
      expect(await search(small, [docs[big]])).toEqual([]);
      expect(await search(big, [docs[small]])).toEqual([]);
    });

    it("refuses to run outside withTenant: fail closed", async () => {
      await expect(
        t.appDb.transaction((tx) => lexicalSearch(tx, "payout", { documentIds: [docs[small]], limit: 5 })),
      ).rejects.toThrow();
    });
  });
});
