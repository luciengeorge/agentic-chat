import { describe, expect, it } from "vitest";

import { rrf } from "./rrf";

describe("rrf", () => {
  it("sums 1 / (k + rank) over the lists", () => {
    const fused = rrf([
      ["a", "b", "c"],
      ["c", "a"],
    ]);
    expect(fused.map((entry) => entry.id)).toEqual(["a", "c", "b"]);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(fused[1].score).toBeCloseTo(1 / 63 + 1 / 61, 12);
    expect(fused[2].score).toBeCloseTo(1 / 62, 12);
  });

  it("ranks an id that tops one list alongside one that tops the other", () => {
    // BM25 alone finds the contract number; the vectors alone find something else. Both reach the top two.
    const fused = rrf([["contract"], ["other", "x", "y"]]);
    expect(
      fused
        .slice(0, 2)
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["contract", "other"]);
  });

  it("counts an id once per list, at its best rank", () => {
    expect(rrf([["a", "a"]])).toEqual([{ id: "a", score: 1 / 61 }]);
  });

  it("takes k as an argument", () => {
    expect(rrf([["a"]], 0)).toEqual([{ id: "a", score: 1 }]);
  });

  it("returns nothing for no lists", () => {
    expect(rrf([])).toEqual([]);
    expect(rrf([[], []])).toEqual([]);
  });
});
