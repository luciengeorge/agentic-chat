import { MockEmbeddingModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { aiSdkEmbedder, batches } from "./embed";
import { hashingEmbedder, words } from "./fake";

const cosine = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);

describe("batches", () => {
  it("splits values into runs of at most `size`", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batches([], 3)).toEqual([]);
  });

  it("refuses a size below one", () => {
    expect(() => batches([1], 0)).toThrow(RangeError);
  });
});

describe("aiSdkEmbedder", () => {
  it("calls embedMany once per batch, keeps the order, and passes the dimensions", async () => {
    const calls: { values: string[]; dimensions: number | undefined }[] = [];
    const model = new MockEmbeddingModelV4({
      maxEmbeddingsPerCall: 100,
      doEmbed: async ({ values, dimensions }) => {
        calls.push({ values, dimensions });
        return { embeddings: values.map((value) => [Number(value), 0, 0]), usage: { tokens: 10 }, warnings: [] };
      },
    });
    let tokens = 0;
    const embedder = aiSdkEmbedder(model, {
      version: "mock@3",
      dimensions: 3,
      batchSize: 2,
      onUsage: (used) => (tokens += used),
    });

    const vectors = await embedder.embed(["1", "2", "3", "4", "5"]);

    expect(vectors.map((vector) => vector[0])).toEqual([1, 2, 3, 4, 5]);
    expect(calls.map((call) => call.values)).toEqual([["1", "2"], ["3", "4"], ["5"]]);
    expect(calls.every((call) => call.dimensions === 3)).toBe(true);
    expect(tokens).toBe(30);
  });

  it("refuses vectors of the wrong length", async () => {
    const model = new MockEmbeddingModelV4({
      doEmbed: async ({ values }) => ({ embeddings: values.map(() => [1, 0]), warnings: [] }),
    });
    await expect(aiSdkEmbedder(model, { version: "mock@3", dimensions: 3 }).embed(["a"])).rejects.toThrow(
      /2 dimensions, expected 3/,
    );
  });
});

describe("hashingEmbedder", () => {
  const embedder = hashingEmbedder(1536);

  it("splits words on anything but letters and digits", () => {
    expect(words("Contract KPC-2026-0142, £40 a day")).toEqual(["contract", "kpc", "2026", "0142", "40", "a", "day"]);
  });

  it("is deterministic, unit length, and names its version", async () => {
    const [a] = await embedder.embed(["expenses policy for London hotels"]);
    const [b] = await embedder.embed(["expenses policy for London hotels"]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(1536);
    expect(Math.hypot(...a)).toBeCloseTo(1, 10);
    expect(embedder.version).toBe("fake-hashing-v1@1536");
  });

  it("puts texts that share words closer than texts that don't", async () => {
    const [query, near, far] = await embedder.embed([
      "London hotel limit",
      "the nightly hotel limit in London is £200",
      "board vote on the acquisition",
    ]);
    expect(cosine(query, near)).toBeGreaterThan(cosine(query, far));
  });

  it("gives an empty text a direction", async () => {
    const [empty] = await embedder.embed([""]);
    expect(Math.hypot(...empty)).toBeCloseTo(1, 10);
  });
});
