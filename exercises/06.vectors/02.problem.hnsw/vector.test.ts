// @vitest-environment node
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { vectorSearch } from "#learn/search/vector";
import { cosineSimilarity, RECORDED_MODEL, recordedChunks, recordedQuery } from "@/core/vectors/recording";
import { type LoadedCorpus, loadRecordedCorpus, tenantDocuments } from "@/core/vectors/testing";
import { relations } from "@/db/relations";
import { type Tx, withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

/** What the planner does on a big table: walk the HNSW index. On 434 rows it would sort them all instead. */
async function useTheIndex(tx: Tx) {
  await tx.execute(sql`SET LOCAL enable_seqscan = off`);
  await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
  await tx.execute(sql`SET LOCAL enable_sort = off`);
}

describe.skipIf(!postgresAvailable)("vectorSearch", () => {
  let t: TestDatabase;
  let corpus: LoadedCorpus;
  const inTenant = <T>(tenant: "kestrel" | "harbour", fn: (tx: Tx) => Promise<T>) =>
    withTenantOn(t.appDb, corpus.tenants[tenant], fn);
  const keyOf = (id: string) => corpus.keys.get(id)!;

  beforeAll(async () => {
    t = await createTestDatabase();
    corpus = await loadRecordedCorpus(t.db);
  }, 120_000);

  afterAll(async () => {
    await t?.drop();
  });

  it("returns the nearest chunks best first, scored by cosine similarity", async () => {
    const { embedding } = recordedQuery("expenses-london-hotel");
    const hits = await inTenant("kestrel", (tx) =>
      vectorSearch(tx, embedding, {
        documentIds: tenantDocuments(corpus, "kestrel"),
        modelVersion: RECORDED_MODEL,
        limit: 5,
      }),
    );
    expect(hits).toHaveLength(5);
    const scores = hits.map((hit) => hit.score);
    expect(scores, "best first: the smallest distance, so the largest similarity, comes first").toEqual(
      [...scores].sort((a, b) => b - a),
    );
    for (const hit of hits) {
      const chunk = recordedChunks().find((c) => c.key === keyOf(hit.id))!;
      expect(hit.score, `${chunk.key}: score is the cosine similarity, 1 - distance`).toBeCloseTo(
        cosineSimilarity(embedding, chunk.embedding),
        5,
      );
    }
    expect(keyOf(hits[0].id)).toBe("/HR/Policies/Travel and Expenses Policy v2.pdf#10");
    expect(hits[0].score).toBeCloseTo(0.6885, 4);
  });

  it("keeps to the pre-filter's documents and the model version", async () => {
    const { embedding } = recordedQuery("expenses-london-hotel");
    const oldPolicy = corpus.documentIds.get("/HR/Policies/Travel and Expenses Policy.pdf")!;
    const search = (modelVersion: string, documentIds: string[]) =>
      inTenant("kestrel", (tx) => vectorSearch(tx, embedding, { documentIds, modelVersion, limit: 5 }));
    const hits = await search(RECORDED_MODEL, [oldPolicy]);
    expect(hits, "the old policy alone has 18 chunks, so 5 come back").toHaveLength(5);
    expect(
      hits.map((hit) => keyOf(hit.id).split("#")[0]),
      "only chunks of the listed documents: that list is the ACL pre-filter",
    ).toEqual(Array(5).fill("/HR/Policies/Travel and Expenses Policy.pdf"));
    expect(
      await search("text-embedding-3-large@3072", [oldPolicy]),
      "vectors of another model aren't comparable: keep to embedding_model_version",
    ).toEqual([]);
    expect(await search(RECORDED_MODEL, [])).toEqual([]);
  });

  it("leaves no setting on the pooled connection after the transaction", async () => {
    const client = postgres(t.appUrl, { max: 1, onnotice: () => {} });
    const one = drizzle({ client, relations });
    try {
      await withTenantOn(one, corpus.tenants.kestrel, (tx) =>
        vectorSearch(tx, recordedQuery("expenses-london-hotel").embedding, {
          documentIds: tenantDocuments(corpus, "kestrel"),
          modelVersion: RECORDED_MODEL,
          limit: 5,
          efSearch: 77,
        }),
      );
      const [{ iterative, ef }] = await client`
        SELECT current_setting('hnsw.iterative_scan') AS iterative, current_setting('hnsw.ef_search') AS ef`;
      expect(
        [iterative, ef],
        "the next request on this connection inherited your settings: use SET LOCAL, which ends with the transaction",
      ).toEqual(["off", "40"]);
    } finally {
      await client.end();
    }
  });

  it("the worked example: a Harbour user asking about Kestrel's KC-PRO-12 still gets 10 Harbour chunks", async () => {
    const { embedding } = recordedQuery("harbour-asks-kestrel");
    const vector = JSON.stringify(embedding);

    // The problem: a plain HNSW scan hands back its 40 nearest, every one Kestrel's, and RLS removes them all.
    const plain = await inTenant("harbour", async (tx) => {
      await useTheIndex(tx);
      await tx.execute(sql`SET LOCAL hnsw.ef_search = 40`);
      await tx.execute(sql`SET LOCAL hnsw.iterative_scan = off`);
      return tx.execute(sql`SELECT id FROM chunks ORDER BY embedding <=> ${vector}::vector LIMIT 10`);
    });
    expect(plain.length).toBeLessThanOrEqual(1);

    const hits = await inTenant("harbour", async (tx) => {
      await useTheIndex(tx);
      return vectorSearch(tx, embedding, {
        documentIds: tenantDocuments(corpus, "harbour"),
        modelVersion: RECORDED_MODEL,
        limit: 10,
        efSearch: 40,
      });
    });
    expect(
      hits.length,
      "the 158 chunks nearest this question are all Kestrel's, and RLS drops them after the scan: " +
        "turn on hnsw.iterative_scan so the scan keeps going until 10 Harbour chunks pass",
    ).toBe(10);
    expect(hits.every((hit) => recordedChunks().find((c) => c.key === keyOf(hit.id))!.tenant === "harbour")).toBe(true);
    // Harbour's nearest chunk is only 159th of the 434: its procurement process, at 0.2718. Kestrel's price list
    // is at 0.6861. The walk is approximate, so it may come back with the next one (0.2552) first.
    expect(hits[0].score).toBeLessThanOrEqual(0.2719);
    expect(hits[0].score).toBeGreaterThan(0.25);
    const scores = hits.map((hit) => hit.score);
    expect(scores, "relaxed_order may return rows out of order: sort them again outside").toEqual(
      [...scores].sort((a, b) => b - a),
    );
  });
});
