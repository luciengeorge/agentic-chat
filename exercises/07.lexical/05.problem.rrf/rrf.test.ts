// @vitest-environment node
import { describe, expect, it } from "vitest";

import { bm25Search, buildBm25Index } from "#learn/search/bm25";
import { rrf } from "#learn/search/rrf";
import { cosineSimilarity, recordedChunks, recordedQuery } from "@/core/vectors/recording";

describe("rrf", () => {
  it("sums 1 / (60 + rank) over the lists, ranks counted from 1", () => {
    const fused = rrf([
      ["a", "b", "c"],
      ["c", "a"],
    ]);
    expect(
      fused.map((entry) => entry.id),
      "highest total first",
    ).toEqual(["a", "c", "b"]);
    expect(fused[0].score, "a is 1st and 2nd: 1/61 + 1/62").toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(fused[1].score).toBeCloseTo(1 / 63 + 1 / 61, 12);
    expect(fused[2].score).toBeCloseTo(1 / 62, 12);
    expect(rrf([["a"]]), "the first place is rank 1: 1 / (60 + 1)").toEqual([{ id: "a", score: 1 / 61 }]);
  });

  it("keeps an id that only one list found", () => {
    const fused = rrf([["contract"], ["other", "x"]]);
    expect(
      fused.map((entry) => entry.id).sort(),
      "BM25 alone found the contract: keep every id of every list, shared or not",
    ).toEqual(["contract", "other", "x"]);
  });

  it("counts an id once per list, at its best rank", () => {
    expect(rrf([["a", "b", "a"]]), "a twice in one list counts once, at rank 1").toEqual([
      { id: "a", score: 1 / 61 },
      { id: "b", score: 1 / 62 },
    ]);
  });

  it("keeps ties in the order the ids were first seen", () => {
    expect(
      rrf([
        ["b", "a"],
        ["a", "b"],
      ]).map((entry) => entry.id),
      "a and b tie at 1/61 + 1/62; b was seen first",
    ).toEqual(["b", "a"]);
  });

  it("takes k as an argument, and returns nothing for no lists", () => {
    expect(rrf([["a"]], 0)).toEqual([{ id: "a", score: 1 }]);
    expect(rrf([])).toEqual([]);
    expect(rrf([[], []])).toEqual([]);
  });
});

describe("the worked example", () => {
  it("fuses Leo's question: the register's chunk 7 first, the MSA third, where raw scores would just be BM25", () => {
    const { question, embedding } = recordedQuery("kpc-2026-0142-owner");
    const kestrel = recordedChunks().filter((chunk) => chunk.tenant === "kestrel");
    const mine = new Set(kestrel.map((chunk) => chunk.key));
    const index = buildBm25Index(recordedChunks().map((chunk) => ({ id: chunk.key, text: chunk.text })));
    // 40 from each list, as retrieval takes (`perList`).
    const bm25 = bm25Search(index, question)
      .filter((hit) => mine.has(hit.id))
      .slice(0, 40);
    const vectors = kestrel
      .map((chunk) => ({ id: chunk.key, score: cosineSimilarity(embedding, chunk.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 40);

    const fused = rrf([bm25.map((hit) => hit.id), vectors.map((hit) => hit.id)]);
    const name = (id: string) => id.split("/").pop();
    expect(fused.slice(0, 3).map((entry) => name(entry.id))).toEqual([
      "Contract Register 2026-09-28.pdf#7", // BM25 4th, vectors 3rd: 1/64 + 1/63
      "Contract Register 2026-09-28.pdf#6", // BM25 9th, vectors 1st: 1/69 + 1/61
      "KPC-2026-0142 Ashgrove MSA (executed).pdf#0", // BM25 1st, vectors 10th: 1/61 + 1/70
    ]);
    expect(fused.slice(0, 3).map((entry) => Number(entry.score.toFixed(5)))).toEqual([0.0315, 0.03089, 0.03068]);

    // Adding the raw scores instead: BM25's 22 swamps cosine's 0.5, and the order is BM25's.
    const raw = new Map<string, number>();
    for (const hit of [...bm25, ...vectors]) raw.set(hit.id, (raw.get(hit.id) ?? 0) + hit.score);
    const byRaw = [...raw].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    expect(byRaw.slice(0, 3)).toEqual(bm25.slice(0, 3).map((hit) => hit.id));
  });
});
