// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lexicalSearch } from "#learn/search/lexical";
import { recordedQuery } from "@/core/vectors/recording";
import { type LoadedCorpus, loadRecordedCorpus, tenantDocuments } from "@/core/vectors/testing";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

const V1 = "/HR/Policies/Travel and Expenses Policy.pdf";
const V2 = "/HR/Policies/Travel and Expenses Policy v2.pdf";

describe.skipIf(!postgresAvailable)("lexicalSearch", () => {
  let t: TestDatabase;
  let corpus: LoadedCorpus;
  const search = (query: string, options: { documentIds?: string[]; limit?: number } = {}) =>
    withTenantOn(t.appDb, corpus.tenants.kestrel, (tx) =>
      lexicalSearch(tx, query, {
        documentIds: options.documentIds ?? tenantDocuments(corpus, "kestrel"),
        limit: options.limit ?? 5,
      }),
    );
  const keys = async (query: string, options?: { documentIds?: string[]; limit?: number }) =>
    (await search(query, options)).map((hit) => corpus.keys.get(hit.id)!);

  beforeAll(async () => {
    t = await createTestDatabase();
    corpus = await loadRecordedCorpus(t.db);
  }, 120_000);

  afterAll(async () => {
    await t?.drop();
  });

  it("ranks chunks by BM25, best first", async () => {
    const hits = await search("hotel", { limit: 50 });
    expect(hits, "11 Kestrel chunks hold the word hotel").toHaveLength(11);
    const scores = hits.map((hit) => hit.score);
    expect(scores, "best first: order by pdb.score(id), highest first").toEqual([...scores].sort((a, b) => b - a));
    expect(scores[0], "the score is pdb.score(id): BM25, plus 1 for the document filter").toBeCloseTo(6.8083, 4);
  });

  it("matches any of the query's words, not all of them", async () => {
    expect(
      await keys("hotel zebra"),
      "no chunk says zebra, but the hotel chunks should still come back: match any term (|||), not all",
    ).toEqual(await keys("hotel"));
  });

  it("reads the words as the index cut them: stemmed, without stopwords", async () => {
    expect(
      await keys("nights"),
      "nights and night are one term to the index: search its field, not the letters",
    ).toEqual(await keys("night"));
    expect(await keys("the"), "the is a stopword: the index doesn't keep it").toEqual([]);
  });

  it("treats the query as text, never as SQL or query syntax", async () => {
    expect(
      await keys("O'Brien's: (KPC-2026-0142) AND"),
      "pass the query as a parameter: a quote or a bracket is just text",
    ).toEqual(await keys("KPC-2026-0142"));
  });

  it("returns only chunks of the listed documents", async () => {
    const hits = await keys("hotel", { documentIds: [corpus.documentIds.get(V1)!], limit: 50 });
    expect(hits.length).toBeGreaterThan(0);
    expect(
      hits.every((key) => key.startsWith(`${V1}#`)),
      "a chunk of another document came back: keep to documentIds, the ACL pre-filter",
    ).toBe(true);
    expect(await keys("hotel", { documentIds: tenantDocuments(corpus, "harbour") })).toEqual([]);
  });

  it("breaks a tie by id, so the same search always gives the same order", async () => {
    // Chunk 8 of both versions is the same limits table, word for word, so they score the same.
    const hits = await search("hotel", { limit: 50 });
    const tied = hits.filter((hit) => hit.score === hits[0].score);
    expect(tied.map((hit) => corpus.keys.get(hit.id)).sort()).toEqual([`${V1}#8`, `${V2}#8`].sort());
    expect(
      tied.map((hit) => hit.id),
      "equal scores must come back in id order",
    ).toEqual(tied.map((hit) => hit.id).sort());
  });

  it("the worked example: Rachel's hotel question, as the index reads it", async () => {
    const { question } = recordedQuery("expenses-london-hotel");
    const [{ terms }] = await t.sql<{ terms: string[] }[]>`
      SELECT ${question}::pdb.unicode_words('stemmer=english', 'stopwords_language=english')::text[] AS terms`;
    expect(terms).toEqual(["what", "night", "limit", "hotel", "london"]);

    const hits = await search(question);
    expect(hits.map((hit) => corpus.keys.get(hit.id))).toEqual([
      `${V2}#18`,
      `${V1}#8`,
      `${V2}#8`,
      `${V2}#10`,
      `${V1}#10`,
    ]);
    expect(hits.map((hit) => Number(hit.score.toFixed(4)))).toEqual([20.5513, 19.2473, 19.2473, 16.5093, 16.0552]);
  });
});
