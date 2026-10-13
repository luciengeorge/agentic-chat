// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Embedder } from "#learn/embed/embed";

import { hashingEmbedder } from "#learn/embed/fake";

import { embedPendingChunks } from "./embeddings";
import { chunks, documents } from "./schema";
import { type Tx, withTenantOn } from "./tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "./testing";

describe.skipIf(!postgresAvailable)("embedPendingChunks", () => {
  let t: TestDatabase;
  let tenantId: string;
  const documentId = randomUUID();
  const withTenant = <T>(id: string, fn: (tx: Tx) => Promise<T>) => withTenantOn(t.appDb, id, fn);

  const counting = (inner: Embedder, calls: string[][]): Embedder => ({
    ...inner,
    embed: async (values) => {
      calls.push(values);
      return inner.embed(values);
    },
  });

  const versions = async () =>
    (
      await t.sql`
        SELECT ordinal, embedding_model_version AS version, vector_dims(embedding) AS dims
        FROM chunks ORDER BY ordinal`
    ).map((row) => ({ ...row }));

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: tenantId }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
    await t.db.insert(documents).values({
      id: documentId,
      tenantId,
      source: "test",
      externalId: "doc",
      title: "doc",
      path: "/doc",
      mimeType: "text/markdown",
      version: 1,
      sourceVersion: "1",
      contentHash: "x",
      status: "ingesting",
    });
    await t.db.insert(chunks).values(
      Array.from({ length: 5 }, (_, ordinal) => ({
        tenantId,
        documentId,
        documentVersion: 1,
        ordinal,
        text: `chunk ${ordinal}`,
        tokenCount: 2,
      })),
    );
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("embeds pending chunks in batches, records the version, and resumes after a failed batch", async () => {
    const calls: string[][] = [];
    let failed = false;
    const flaky: Embedder = {
      ...hashingEmbedder(1536),
      embed: async (values) => {
        if (calls.length === 1 && !failed) {
          failed = true;
          throw new Error("429");
        }
        calls.push(values);
        return hashingEmbedder(1536).embed(values);
      },
    };
    await expect(embedPendingChunks(withTenant, flaky, { tenantId, documentId, batchSize: 2 })).rejects.toThrow("429");
    expect((await versions()).filter((row) => row.version !== null)).toHaveLength(2);

    const result = await embedPendingChunks(withTenant, flaky, { tenantId, documentId, batchSize: 2 });
    expect(result).toEqual({ chunks: 3, tokens: 6, batches: 2 });
    expect(calls.flat()).toHaveLength(5);
    expect(await versions()).toEqual(
      [0, 1, 2, 3, 4].map((ordinal) => ({ ordinal, version: "fake-hashing-v1@1536", dims: 1536 })),
    );
  });

  it("does nothing when every chunk has the current model's embedding", async () => {
    const calls: string[][] = [];
    const result = await embedPendingChunks(withTenant, counting(hashingEmbedder(1536), calls), { tenantId });
    expect(result.chunks).toBe(0);
    expect(calls).toEqual([]);
  });

  it("re-embeds chunks another model embedded", async () => {
    const other: Embedder = { ...hashingEmbedder(1536), version: "other@1536" };
    const result = await embedPendingChunks(withTenant, other, { tenantId, documentVersion: 1 });
    expect(result.chunks).toBe(5);
    expect(new Set((await versions()).map((row) => row.version))).toEqual(new Set(["other@1536"]));
  });

  it("touches nothing outside the tenant", async () => {
    const result = await embedPendingChunks(withTenant, hashingEmbedder(1536), { tenantId: randomUUID() });
    expect(result.chunks).toBe(0);
  });
});
