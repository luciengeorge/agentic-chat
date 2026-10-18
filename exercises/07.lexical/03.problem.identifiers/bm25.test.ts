// @vitest-environment node
import { describe, expect, it } from "vitest";

import { bm25Search, buildBm25Index, explainScore, idf } from "#learn/search/bm25";
import { cosineSimilarity, recordedChunks, recordedQueries, recordedQuery } from "@/core/vectors/recording";

const chunks = recordedChunks();
const index = buildBm25Index(chunks.map((chunk) => ({ id: chunk.key, text: chunk.text })));
const MSA = "/Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf#0";

describe("explainScore", () => {
  it("adds up to bm25Search's score, for every recorded question's top 5", () => {
    for (const q of recordedQueries()) {
      for (const hit of bm25Search(index, q.question).slice(0, 5)) {
        expect(
          explainScore(index, q.question, hit.id)!.score,
          `${q.id}, ${hit.id}: the parts must sum to bm25Search's score (each distinct term once)`,
        ).toBeCloseTo(hit.score, 10);
      }
    }
  });

  it("lists each distinct query term once, in query order, absent ones with tf 0", () => {
    const explained = explainScore(
      index,
      "KPC-2026-0142 kpc zebra",
      "/Legal/Contracts/Contract Register 2026-09-28.pdf#7",
    )!;
    expect(
      explained.terms.map((t) => t.term),
      "kpc appears twice in the query but once here; zebra is absent but still listed",
    ).toEqual(["kpc", "2026", "0142", "zebra"]);
    expect(explained.terms[3]).toEqual({ term: "zebra", tf: 0, documentFrequency: 0, idf: idf(434, 0), score: 0 });
  });

  it("takes df and idf from the whole index, tf from the one document", () => {
    const [kpc, , digits] = explainScore(index, "KPC-2026-0142", MSA)!.terms;
    expect(kpc.tf, "tf counts the term in this document").toBe(index.termCounts[index.ids.indexOf(MSA)].get("kpc"));
    expect([kpc.documentFrequency, digits.documentFrequency], "df counts the documents holding it").toEqual([28, 9]);
    expect(digits.idf).toBeCloseTo(idf(434, 9), 12);
  });

  it("returns null for a document the index doesn't hold", () => {
    expect(explainScore(index, "KPC-2026-0142", "nope")).toBeNull();
  });
});

describe("the worked example", () => {
  const rankByVector = (id: string) => {
    const { embedding } = recordedQuery(id);
    return chunks
      .map((chunk) => ({ key: chunk.key, similarity: cosineSimilarity(embedding, chunk.embedding) }))
      .sort((a, b) => b.similarity - a.similarity);
  };
  const holds = (key: string, identifier: string) => chunks.find((c) => c.key === key)!.text.includes(identifier);

  it("Leo's question: BM25 puts the MSA first, mostly on 'initial' and '0142'; vectors put it 10th", () => {
    const { question } = recordedQuery("kpc-2026-0142-owner");
    const [first] = bm25Search(index, question);
    expect(first.id).toBe(MSA);
    const explained = explainScore(index, question, MSA)!;
    expect(explained.score).toBeCloseTo(22.1736, 4);
    const parts = Object.fromEntries(explained.terms.map((t) => [t.term, Number(t.score.toFixed(4))]));
    expect(parts).toMatchObject({ initial: 6.0591, term: 3.9449, "0142": 3.3624, contract: 3.0142, and: 0.2678 });
    expect(parts.who, "'who' isn't on the MSA's first page: listed, with score 0").toBe(0);

    const byVector = rankByVector("kpc-2026-0142-owner");
    const msa = byVector.findIndex((r) => r.key === MSA);
    expect(msa + 1).toBe(10);
    expect(byVector[msa].similarity).toBeCloseTo(0.503, 4);
    expect(byVector[0].key).toBe("/Legal/Contracts/Contract Register 2026-09-28.pdf#6");
  });

  it("the bare number: 7 of BM25's top 10 hold KPC-2026-0142, 2 of the vectors' do", () => {
    const bm25 = bm25Search(index, "KPC-2026-0142").slice(0, 10);
    const vectors = rankByVector("kpc-2026-0142").slice(0, 10);
    expect(bm25.filter((hit) => holds(hit.id, "KPC-2026-0142")).length).toBe(7);
    expect(vectors.filter((hit) => holds(hit.key, "KPC-2026-0142")).length).toBe(2);
    // The vectors' best is a page of the register about other contracts.
    expect(holds(vectors[0].key, "KPC-2026-0142")).toBe(false);
    expect(vectors[0].similarity).toBeCloseTo(0.3955, 4);
  });
});
