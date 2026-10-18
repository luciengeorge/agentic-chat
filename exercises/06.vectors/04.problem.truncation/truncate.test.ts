// @vitest-environment node
import { describe, expect, it } from "vitest";

import { bytesPerVector } from "#learn/vectors/sizing";
import { truncateEmbedding } from "#learn/vectors/truncate";
import { cosineSimilarity, distinctChunks, goldenQueries, recordedQuery } from "@/core/vectors/recording";

const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const top10 = (score: (embedding: number[], i: number) => number, rows = distinctChunks()) =>
  rows
    .map((row, i) => ({ key: row.key, score: score(row.embedding, i) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((row) => row.key);

describe("truncateEmbedding", () => {
  it("keeps the first numbers, scaled back to length 1", () => {
    // [0.6, 0] has length 0.6, so it becomes [1, 0].
    expect(truncateEmbedding([0.6, 0, 0.8], 2), "divide the prefix by its own length").toEqual([1, 0]);
    expect(truncateEmbedding([3, 4, 12], 2), "the length is the square root of the sum of squares: 5").toEqual([
      0.6, 0.8,
    ]);
    const { embedding } = recordedQuery("expenses-london-hotel");
    const short = truncateEmbedding(embedding, 256);
    expect(short).toHaveLength(256);
    expect(Math.hypot(...short), "a truncated vector must have length 1 again").toBeCloseTo(1, 12);
  });

  it("points the same way: every number divided by the same length", () => {
    const { embedding } = recordedQuery("expenses-london-hotel");
    const short = truncateEmbedding(embedding, 256);
    expect(short[3] / short[0]).toBeCloseTo(embedding[3] / embedding[0], 12);
    expect(cosineSimilarity(short, embedding.slice(0, 256)), "same direction as the raw prefix").toBeCloseTo(1, 12);
  });

  it("refuses sizes it can't keep, and a prefix with no direction", () => {
    for (const n of [0, 4, 1.5])
      expect(
        () => truncateEmbedding([1, 0, 0], n),
        `keep ${n} of 3: refuse a size that isn't a whole number from 1 to the length`,
      ).toThrow(RangeError);
    expect(() => truncateEmbedding([0, 0, 1], 2), "an all-zero prefix has no length to divide by").toThrow(RangeError);
  });

  it("lets inner product rank every golden question exactly as cosine similarity does", () => {
    const rows = distinctChunks();
    const prefixes = rows.map((row) => truncateEmbedding(row.embedding, 256));
    for (const q of goldenQueries()) {
      const query = truncateEmbedding(q.embedding, 256);
      const byInner = top10((_, i) => dot(query, prefixes[i]), rows);
      const byCosine = top10((e) => cosineSimilarity(q.embedding.slice(0, 256), e.slice(0, 256)), rows);
      expect(
        byInner,
        `${q.id}: inner product counted each chunk's prefix length as if it were meaning; scale every prefix to length 1`,
      ).toEqual(byCosine);
    }
  });

  it("the worked example: 256 of 1,536 dimensions keep 77.0% of the true top 10, in a sixth of the bytes", () => {
    const { embedding } = recordedQuery("expenses-london-hotel");
    expect(Math.hypot(...embedding.slice(0, 256))).toBeCloseTo(0.4719, 4);

    const rows = distinctChunks();
    const recall = (n: number) => {
      const prefixes = rows.map((row) => ({ ...row, embedding: truncateEmbedding(row.embedding, n) }));
      let sum = 0;
      for (const q of goldenQueries()) {
        const truth = top10((e) => cosineSimilarity(q.embedding, e), rows);
        const query = truncateEmbedding(q.embedding, n);
        const found = new Set(top10((e) => dot(query, e), prefixes));
        sum += truth.filter((key) => found.has(key)).length / 10;
      }
      return sum / goldenQueries().length;
    };
    expect(recall(256)).toBeCloseTo(0.77, 3);
    expect(recall(512)).toBeCloseTo(0.872, 3);
    expect(recall(1024)).toBeCloseTo(0.939, 3);
    expect([bytesPerVector("vector", 1536), bytesPerVector("vector", 256)]).toEqual([6152, 1032]);
  });
});
