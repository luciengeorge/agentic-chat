import { MockEmbeddingModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { localEmbedder, NOMIC_PREFIXES, padVector } from "./embed";

const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const cosine = (a: number[], b: number[]) => dot(a, b) / Math.sqrt(dot(a, a) * dot(b, b));

function mockModel(dimensions: number) {
  const calls: string[][] = [];
  const model = new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: 100,
    doEmbed: async ({ values }) => {
      calls.push(values);
      return {
        embeddings: values.map((value) => Array.from({ length: dimensions }, (_, i) => (value.length + i) % 7)),
        warnings: [],
      };
    },
  });
  return { model, calls };
}

describe("padVector", () => {
  it("leaves cosine similarity exactly as it was", () => {
    const a = [0.1, -0.4, 0.7];
    const b = [0.3, 0.2, -0.5];
    expect(cosine(padVector(a, 8), padVector(b, 8))).toBeCloseTo(cosine(a, b), 12);
    expect(padVector(a, 5)).toEqual([0.1, -0.4, 0.7, 0, 0]);
  });

  it("never cuts a vector down", () => {
    expect(() => padVector([1, 2, 3], 2)).toThrow(RangeError);
  });
});

describe("localEmbedder", () => {
  it("prefixes each text for its purpose, pads to the column, and names the real dimension", async () => {
    const { model, calls } = mockModel(4);
    const embedder = localEmbedder(model, { modelId: "nomic", dimensions: 4, purpose: "query", storedDimensions: 6 });

    const [vector] = await embedder.embed(["hotel limit"]);

    expect(calls).toEqual([[`${NOMIC_PREFIXES.query}hotel limit`]]);
    expect(embedder.version).toBe("nomic@4");
    expect(embedder.dimensions).toBe(6);
    expect(vector).toHaveLength(6);
    expect(vector.slice(4)).toEqual([0, 0]);
  });

  it("marks documents as documents", async () => {
    const { model, calls } = mockModel(2);
    await localEmbedder(model, { modelId: "m", dimensions: 2, purpose: "document" }).embed(["a"]);
    expect(calls[0]).toEqual(["search_document: a"]);
  });

  it("sends batches in order", async () => {
    const { model, calls } = mockModel(2);
    const embedder = localEmbedder(model, { modelId: "m", dimensions: 2, purpose: "document", batchSize: 2 });
    const vectors = await embedder.embed(["a", "b", "c"]);
    expect(calls.map((batch) => batch.length)).toEqual([2, 1]);
    expect(vectors).toHaveLength(3);
  });

  it("fails on a vector of the wrong length rather than padding it into the space", async () => {
    const { model } = mockModel(3);
    const embedder = localEmbedder(model, { modelId: "m", dimensions: 4, purpose: "query" });
    await expect(embedder.embed(["a"])).rejects.toThrow("m@4 returned 3 dimensions, expected 4");
  });

  it("refuses a model wider than the column", () => {
    const { model } = mockModel(2);
    expect(() => localEmbedder(model, { modelId: "wide", dimensions: 2048, purpose: "query" })).toThrow(/1536/);
  });
});
