// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { bm25Search, buildBm25Index, explainScore, idf, termScore, tokenize } from "./bm25";

// Three tiny documents. Lengths 3, 3 and 2 tokens, so the average length is 8 / 3 = 2.667.
const CORPUS = [
  { id: "d1", text: "card payment failed" },
  { id: "d2", text: "payment refund payment" },
  { id: "d3", text: "refund issued" },
];

describe("tokenize", () => {
  it("lowercases and splits on anything that isn't a letter or a digit", () => {
    expect(tokenize("Contract KPC-2026-0142, signed.")).toEqual(["contract", "kpc", "2026", "0142", "signed"]);
  });
});

describe("idf", () => {
  it("is high for a rare term and low, but above zero, for a common one", () => {
    // "card" is in 1 of 3 documents: ln(1 + (3 - 1 + 0.5) / (1 + 0.5)) = ln(2.667) = 0.981
    expect(idf(3, 1)).toBeCloseTo(0.980829, 6);
    // "payment" is in 2 of 3: ln(1 + 1.5 / 2.5) = ln(1.6) = 0.470
    expect(idf(3, 2)).toBeCloseTo(0.470004, 6);
    // In every document it still counts a little: ln(1 + 0.5 / 3.5) = 0.134
    expect(idf(3, 3)).toBeCloseTo(0.133531, 6);
  });
});

describe("termScore", () => {
  const cardIdf = idf(3, 1);

  it("saturates: a second mention adds less than the first", () => {
    // len 3, avg 2.667: lengthNorm = 0.25 + 0.75 * 1.125 = 1.094, so k1 * lengthNorm = 1.3125
    const once = termScore(1, cardIdf, 3, 8 / 3); // 0.981 * 2.2 / (1 + 1.3125) = 0.933
    const twice = termScore(2, cardIdf, 3, 8 / 3); // 0.981 * 4.4 / (2 + 1.3125) = 1.303
    expect(once).toBeCloseTo(0.933113, 6);
    expect(twice).toBeCloseTo(1.302837, 6);
    expect(twice / once).toBeLessThan(2);
  });

  it("gives a long document less for the same count, and b = 0 turns that off", () => {
    const short = termScore(1, cardIdf, 2, 8 / 3);
    const long = termScore(1, cardIdf, 20, 8 / 3);
    expect(long).toBeLessThan(short);
    expect(termScore(1, cardIdf, 20, 8 / 3, { k1: 1.2, b: 0 })).toBeCloseTo(
      termScore(1, cardIdf, 2, 8 / 3, { k1: 1.2, b: 0 }),
      12,
    );
  });

  it("is zero when the term is absent", () => {
    expect(termScore(0, cardIdf, 3, 8 / 3)).toBe(0);
  });
});

describe("bm25Search", () => {
  const index = buildBm25Index(CORPUS);

  it("sums the terms' scores: the hand-computed numbers", () => {
    // d1: payment 0.447 + card 0.933 = 1.380. d2: payment twice, 0.624 (less than d1, whose "card" is rare).
    const hits = bm25Search(index, "payment card");
    expect(hits.map((hit) => hit.id)).toEqual(["d1", "d2"]);
    expect(hits[0].score).toBeCloseTo(1.380252, 6);
    expect(hits[1].score).toBeCloseTo(0.624307, 6);
  });

  it("leaves out documents with none of the terms, and counts a repeated query term once", () => {
    expect(bm25Search(index, "card card").map((hit) => hit.id)).toEqual(["d1"]);
    expect(bm25Search(index, "card card")[0].score).toBeCloseTo(bm25Search(index, "card")[0].score, 12);
    expect(bm25Search(index, "nothing here")).toEqual([]);
  });
});

describe("explainScore", () => {
  const index = buildBm25Index(CORPUS);

  it("splits a score into its terms, absent ones included, and the parts add up", () => {
    const explained = explainScore(index, "card payment refund card", "d1")!;
    expect(explained.terms.map((t) => [t.term, t.tf, t.documentFrequency])).toEqual([
      ["card", 1, 1],
      ["payment", 1, 2],
      ["refund", 0, 2],
    ]);
    expect(explained.terms[2].score).toBe(0);
    expect(explained.score).toBeCloseTo(bm25Search(index, "card payment refund")[0].score, 12);
    expect(explainScore(index, "card", "nope")).toBeNull();
  });
});

describe.skipIf(!postgresAvailable)("bm25Search against pg_search", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase({ migrated: false });
    await t.sql`CREATE EXTENSION IF NOT EXISTS pg_search`;
    await t.sql`CREATE TABLE docs (id text PRIMARY KEY, body text NOT NULL)`;
    for (const { id, text } of CORPUS) await t.sql`INSERT INTO docs VALUES (${id}, ${text})`;
    await t.sql`CREATE INDEX docs_bm25 ON docs USING paradedb (id, (body::pdb.simple))`;
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("gives the same scores as pg_search's BM25 index", async () => {
    const rows = await t.sql<{ id: string; score: number }[]>`
      SELECT id, pdb.score(id) AS score FROM docs WHERE body ||| 'payment card' ORDER BY score DESC`;
    const ours = bm25Search(buildBm25Index(CORPUS), "payment card");
    expect(rows.map((row) => row.id)).toEqual(ours.map((hit) => hit.id));
    // pg_search keeps scores as 32-bit floats.
    rows.forEach((row, i) => expect(Number(row.score)).toBeCloseTo(ours[i].score, 5));
  });
});
