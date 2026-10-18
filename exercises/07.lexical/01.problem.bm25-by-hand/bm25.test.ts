// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bm25Search, buildBm25Index, DEFAULT_B, DEFAULT_K1, idf, termScore, tokenize } from "#learn/search/bm25";
import { recordedChunks, recordedQueries } from "@/core/vectors/recording";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

// Three tiny documents. Lengths 3, 3 and 2 tokens, so the average length is 8 / 3 = 2.667.
const CORPUS = [
  { id: "d1", text: "card payment failed" },
  { id: "d2", text: "payment refund payment" },
  { id: "d3", text: "refund issued" },
];

describe("idf", () => {
  it("is high for a rare term and lower for a common one: the hand-worked numbers", () => {
    // "card" is in 1 of 3 documents: ln(1 + (3 - 1 + 0.5) / (1 + 0.5)) = ln(2.667) = 0.981
    expect(idf(3, 1), "ln(1 + (N - df + 0.5) / (df + 0.5)), with the natural log").toBeCloseTo(0.980829, 6);
    // "payment" is in 2 of 3: ln(1 + 1.5 / 2.5) = ln(1.6) = 0.470
    expect(idf(3, 2)).toBeCloseTo(0.470004, 6);
  });

  it("stays above zero for a term in most documents, or in all of them", () => {
    expect(
      idf(434, 363),
      "a term in 363 of 434 chunks scored below zero: Lucene adds 1 inside the log",
    ).toBeGreaterThan(0);
    expect(idf(3, 3), "a term in every document must still count a little: keep the 0.5s").toBeGreaterThan(0);
    expect(idf(434, 363), "ln(1 + (N - df + 0.5) / (df + 0.5)), with the natural log").toBeCloseTo(
      Math.log(1 + 71.5 / 363.5),
      12,
    );
    expect(idf(434, 0)).toBeGreaterThan(idf(434, 9));
  });
});

describe("termScore", () => {
  const cardIdf = 0.980829;

  it("saturates: a second mention adds less than the first", () => {
    // len 3, avg 2.667: lengthNorm = 0.25 + 0.75 * 1.125 = 1.094, so k1 * lengthNorm = 1.3125
    const once = termScore(1, cardIdf, 3, 8 / 3); // 0.981 * 2.2 / (1 + 1.3125) = 0.933
    const twice = termScore(2, cardIdf, 3, 8 / 3); // 0.981 * 4.4 / (2 + 1.3125) = 1.303
    expect(once, "idf × tf × (k1 + 1) / (tf + k1 × lengthNorm)").toBeCloseTo(0.933113, 5);
    expect(twice, "tf goes in twice: idf × tf × (k1 + 1) / (tf + k1 × lengthNorm)").toBeCloseTo(1.302837, 5);
    expect(twice / once, "tf must saturate: twice the mentions is less than twice the score").toBeLessThan(2);
  });

  it("is worth exactly the idf for one mention in a document of average length", () => {
    expect(termScore(1, cardIdf, 10, 10), "the (k1 + 1) on top makes one average mention worth its idf").toBeCloseTo(
      cardIdf,
      12,
    );
  });

  it("gives a long document less for the same count, and b = 0 turns that off", () => {
    const short = termScore(1, cardIdf, 2, 8 / 3);
    const long = termScore(1, cardIdf, 20, 8 / 3);
    expect(long, "a longer document should score less for the same tf").toBeLessThan(short);
    expect(
      termScore(1, cardIdf, 20, 8 / 3, { k1: 1.2, b: 0 }),
      "with b 0 length must not count: lengthNorm = 1 - b + b × length / averageLength",
    ).toBeCloseTo(termScore(1, cardIdf, 2, 8 / 3, { k1: 1.2, b: 0 }), 12);
  });

  it("is zero when the term is absent", () => {
    expect(termScore(0, cardIdf, 3, 8 / 3)).toBe(0);
  });

  it("adds up in bm25Search: the hand-worked scores", () => {
    // d1: payment 0.447 + card 0.933 = 1.380. d2: payment twice, 0.624 (less than d1, whose "card" is rare).
    const hits = bm25Search(buildBm25Index(CORPUS), "payment card");
    expect(hits.map((hit) => hit.id)).toEqual(["d1", "d2"]);
    expect(hits[0].score).toBeCloseTo(1.380252, 5);
    expect(hits[1].score).toBeCloseTo(0.624307, 5);
  });
});

describe("the worked example", () => {
  it("scores KPC-2026-0142 over the 434 recorded chunks: the register's chunk 7 first, at 11.488", () => {
    const chunks = recordedChunks();
    const index = buildBm25Index(chunks.map((chunk) => ({ id: chunk.key, text: chunk.text })));
    expect(tokenize("KPC-2026-0142")).toEqual(["kpc", "2026", "0142"]);
    const df = (term: string) => index.documentFrequency.get(term)!;
    expect([df("kpc"), df("2026"), df("0142")]).toEqual([28, 160, 9]);
    expect(idf(434, 9)).toBeCloseTo(3.8241, 4);
    expect(idf(434, 160)).toBeCloseTo(0.9971, 4);

    const hits = bm25Search(index, "KPC-2026-0142");
    expect(hits).toHaveLength(162);
    expect(hits[0].id).toBe("/Legal/Contracts/Contract Register 2026-09-28.pdf#7");
    // 234 tokens long; kpc 12 times, 2026 17 times, 0142 3 times.
    const i = index.ids.indexOf(hits[0].id);
    const parts = ["kpc", "2026", "0142"].map((term) =>
      termScore(index.termCounts[i].get(term)!, idf(434, df(term)), index.lengths[i], index.averageLength),
    );
    expect(parts.map((part) => Number(part.toFixed(4)))).toEqual([4.9689, 1.9142, 4.6052]);
    expect(hits[0].score).toBeCloseTo(11.4883, 4);
  });
});

describe.skipIf(!postgresAvailable)("your formula against pg_search", () => {
  let t: TestDatabase;
  const chunks = recordedChunks();
  const index = buildBm25Index(chunks.map((chunk) => ({ id: chunk.key, text: chunk.text })));
  // Tantivy keeps a document's length in one byte: exact up to 40 tokens, then rounded down to one of these steps.
  const STEPS = [
    ...Array.from({ length: 41 }, (_, i) => i),
    ...[42, 44, 46, 48, 50, 52, 54, 56, 60, 64, 68, 72, 76, 80, 84, 88, 96, 104, 112, 120, 128, 136, 144, 152],
    ...[168, 184, 200, 216, 232, 248, 264, 280, 312, 344, 376, 408, 440, 472, 504, 536, 600, 664, 728, 792],
  ];
  const stored = (length: number) => STEPS.filter((step) => step <= length).at(-1)!;
  /** Your idf and termScore as pg_search applies them: the stored length, and every query term each time. */
  const pgScore = (query: string, i: number) =>
    tokenize(query).reduce((sum, term) => {
      const tf = index.termCounts[i].get(term) ?? 0;
      if (tf === 0) return sum;
      const termIdf = idf(index.ids.length, index.documentFrequency.get(term)!);
      return (
        sum + termScore(tf, termIdf, stored(index.lengths[i]), index.averageLength, { k1: DEFAULT_K1, b: DEFAULT_B })
      );
    }, 0);

  beforeAll(async () => {
    t = await createTestDatabase({ migrated: false });
    await t.sql`CREATE EXTENSION IF NOT EXISTS pg_search`;
    await t.sql`CREATE TABLE docs (id text PRIMARY KEY, body text NOT NULL)`;
    await t.sql`INSERT INTO docs ${t.sql(chunks.map((chunk) => ({ id: chunk.key, body: chunk.text })))}`;
    // `simple` lowercases and splits on anything that isn't a letter or digit, as tokenize does.
    await t.sql`CREATE INDEX docs_bm25 ON docs USING paradedb (id, (body::pdb.simple))`;
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  });

  it("gives pg_search's scores for every recorded question's top 10, to 32-bit precision", async () => {
    for (const q of recordedQueries()) {
      const rows = await t.sql<{ id: string; score: number }[]>`
        SELECT id, pdb.score(id) AS score FROM docs WHERE body ||| ${q.question} ORDER BY score DESC, id LIMIT 10`;
      for (const row of rows) {
        const ours = pgScore(q.question, index.ids.indexOf(row.id));
        expect(
          ours / Number(row.score),
          `${q.id}, ${row.id}: pg_search says ${row.score}, you say ${ours}`,
        ).toBeCloseTo(1, 5);
      }
    }
  });
});
