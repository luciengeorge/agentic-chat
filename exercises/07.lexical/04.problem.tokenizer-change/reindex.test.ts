// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lexicalSearch } from "#learn/search/lexical";
import {
  BM25_INDEX,
  beginTokenizerChange,
  bm25Indexes,
  compareFields,
  finishTokenizerChange,
  LEXICAL_V1,
  LEXICAL_V2,
} from "#learn/search/reindex";
import { recordedChunks, recordedQueries } from "@/core/vectors/recording";
import { type LoadedCorpus, loadRecordedCorpus, tenantDocuments } from "@/core/vectors/testing";
import { type Tx, withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

/** The eight golden questions about identifiers: contract numbers, error codes, product codes. */
const IDENTIFIER_QUESTIONS = [
  "kpc-2026-0142-owner",
  "kpc-2025-0142-subject",
  "kpc-2026-0412-break",
  "kp-4031-retry",
  "kp-9007-wait",
  "kc-pro-12-price",
  "ka-plus-12-billing",
  "kp-bulk-500-overage",
].map((id) => recordedQueries().find((q) => q.id === id)!.question);

describe.skipIf(!postgresAvailable)("changing the tokenizer without downtime", () => {
  let t: TestDatabase;
  let corpus: LoadedCorpus;
  const inKestrel = <T>(fn: (tx: Tx) => Promise<T>) => withTenantOn(t.appDb, corpus.tenants.kestrel, fn);
  const search = (query: string, field?: string, limit = 500) =>
    inKestrel((tx) => lexicalSearch(tx, query, { documentIds: tenantDocuments(corpus, "kestrel"), limit, field }));
  const texts = async (query: string, field?: string) =>
    (await search(query, field)).map((hit) => recordedChunks().find((c) => c.key === corpus.keys.get(hit.id))!.text);
  const QUERIES = ["2026", "KPC-2026-0142", "running nights", ...IDENTIFIER_QUESTIONS];
  let before: Awaited<ReturnType<typeof search>>[];

  beforeAll(async () => {
    t = await createTestDatabase();
    corpus = await loadRecordedCorpus(t.db);
    before = [];
    for (const query of QUERIES) before.push(await search(query));
  }, 120_000);

  afterAll(async () => {
    await t?.drop();
  });

  it("refuses a new field with the old one's name", async () => {
    await expect(beginTokenizerChange(t.db, LEXICAL_V1, { ...LEXICAL_V2, name: LEXICAL_V1.name })).rejects.toThrow(
      RangeError,
    );
  });

  it("begins the change without changing a single answer, with one index serving", async () => {
    // Searches keep arriving while the change runs, as they would in the app.
    let done = false;
    const failures: string[] = [];
    const traffic = (async () => {
      while (!done)
        await search("hotel", undefined, 5).catch((error: Error) => failures.push(String(error.cause ?? error)));
    })();
    try {
      await beginTokenizerChange(t.db, LEXICAL_V1, LEXICAL_V2);
    } catch (error) {
      const cause = String((error as Error).cause ?? error);
      if (/only have one ParadeDB index/.test(cause)) {
        throw new Error("a second ParadeDB index can only be built with CREATE INDEX CONCURRENTLY", { cause: error });
      }
      throw error;
    } finally {
      done = true;
      await traffic;
    }
    expect(
      failures.slice(0, 1),
      "lexical search failed while the change ran: build the new index before you drop the old one",
    ).toEqual([]);
    expect(
      await bm25Indexes(t.db),
      "one index, under the old name: drop the old index once the new one is built, then rename the new one",
    ).toEqual([BM25_INDEX]);
    for (const [i, query] of QUERIES.entries()) {
      expect(
        await search(query),
        `"${query}" answers differently on text: the transition index must keep the old field exactly as it was`,
      ).toEqual(before[i]);
    }
  });

  it("keeps identifiers whole on the new field", async () => {
    // v1 splits KPC-2026-0142, so its "2026" is a match; v2 keeps the identifier as one term.
    expect((await search("2026")).length).toBe(148);
    expect((await search("2026", LEXICAL_V2.name)).length).toBe(144);
    const whole = await texts("KPC-2026-0142", LEXICAL_V2.name);
    expect(whole).toHaveLength(8);
    expect(whole.every((text) => text.includes("KPC-2026-0142"))).toBe(true);
    expect((await search("KPC-2026-0142")).length, "on v1, any of kpc, 2026 or 0142 is a match").toBe(150);
  });

  it("dual-reads two fields: what each returns, and the share of today's results the new field keeps", async () => {
    const [same, kpc, none] = await inKestrel((tx) =>
      compareFields(tx, ["hotel", "KPC-2026-0142", "zebra"], {
        from: LEXICAL_V1.name,
        to: LEXICAL_V2.name,
        documentIds: tenantDocuments(corpus, "kestrel"),
        limit: 10,
      }),
    );
    expect(same.query).toBe("hotel");
    expect(same.from, "from: the ids lexicalSearch gives on the `from` field").toEqual(
      (await search("hotel", LEXICAL_V1.name, 10)).map((hit) => hit.id),
    );
    expect(same.to, "to: the ids on the `to` field").toEqual(
      (await search("hotel", LEXICAL_V2.name, 10)).map((hit) => hit.id),
    );
    expect(same.overlap).toBe(1);
    // On text, 10 chunks match some piece of KPC-2026-0142; on text_v2 only 8 hold it whole, 7 of them among the 10.
    expect([kpc.from.length, kpc.to.length]).toEqual([10, 8]);
    expect(kpc.overlap, "the share of from's ids that to also returned: 7 of from's 10").toBe(0.7);
    expect(none, "nothing on either field is no change: overlap 1").toMatchObject({ from: [], to: [], overlap: 1 });
  });

  it("the worked example: the dual read over the eight identifier questions, then the finish", async () => {
    const results = await inKestrel((tx) =>
      compareFields(tx, IDENTIFIER_QUESTIONS, {
        from: LEXICAL_V1.name,
        to: LEXICAL_V2.name,
        documentIds: tenantDocuments(corpus, "kestrel"),
        limit: 10,
      }),
    );
    expect(
      results.map((result) => result.overlap),
      "overlap: the share of from's ids that to also returned",
    ).toEqual([0.6, 0.7, 0.8, 0.8, 0.9, 0.9, 0.5, 0.6]);
    const [kpc] = results;
    expect(corpus.keys.get(kpc.from[0])).toBe("/Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf#0");
    expect(corpus.keys.get(kpc.to[0])).toBe("/Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf#0");

    await finishTokenizerChange(t.db, LEXICAL_V2);
    expect(await bm25Indexes(t.db)).toEqual([BM25_INDEX]);
    expect((await search("2026", LEXICAL_V2.name)).length).toBe(144);
  });
});
