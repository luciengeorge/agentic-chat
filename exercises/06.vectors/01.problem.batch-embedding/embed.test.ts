// @vitest-environment node
import { MockEmbeddingModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { countTokens } from "#learn/chunk/tokens";
import { aiSdkEmbedder, batches, DEFAULT_BATCH_SIZE } from "#learn/embed/embed";
import { filingTokenCounts, recordedChunks } from "@/core/vectors/recording";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A model that answers each text with [its number, 0, 0], and records what each call asked for. */
function numberModel(delays: number[] = []) {
  const calls: { values: string[]; dimensions: number | undefined }[] = [];
  const model = new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: 2048,
    doEmbed: async ({ values, dimensions }) => {
      const call = calls.push({ values, dimensions }) - 1;
      await sleep(delays[call] ?? 0);
      return { embeddings: values.map((v) => [Number(v), 0, 0]), usage: { tokens: values.length * 10 }, warnings: [] };
    },
  });
  return { model, calls };
}

const numbers = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));

describe("batches", () => {
  it("cuts values into runs of `size`, in order, the last one shorter, nothing dropped", () => {
    expect(batches([1, 2, 3, 4, 5], 2), "the last, shorter run went missing").toEqual([[1, 2], [3, 4], [5]]);
    expect(batches([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(batches([1, 2], 5)).toEqual([[1, 2]]);
    expect(batches([], 3), "no values make no runs, not one empty run").toEqual([]);
  });

  it("refuses a size below one, or not a whole number", () => {
    expect(() => batches([1], 0)).toThrow(RangeError);
    expect(() => batches([1], 1.5)).toThrow(RangeError);
  });
});

describe("aiSdkEmbedder", () => {
  it("makes one call per batch and passes the dimensions", async () => {
    const { model, calls } = numberModel();
    const vectors = await aiSdkEmbedder(model, { version: "mock@3", dimensions: 3, batchSize: 2 }).embed(numbers(5));
    expect(
      calls.map((call) => call.values),
      "each batch of `batchSize` values is one call",
    ).toEqual([["1", "2"], ["3", "4"], ["5"]]);
    expect(
      calls.map((call) => call.dimensions),
      "pass `dimensions` to embedMany on every call",
    ).toEqual([3, 3, 3]);
    expect(vectors).toHaveLength(5);
  });

  it("keeps the order: vector i belongs to text i, even when a later call answers first", async () => {
    // The first call takes 60 ms, the others none: pushing each batch as it arrives would put it last.
    const { model } = numberModel([60, 0, 0]);
    const vectors = await aiSdkEmbedder(model, { version: "mock@3", dimensions: 3, batchSize: 2 }).embed(numbers(5));
    expect(
      vectors.map((vector) => vector[0]),
      "the vectors came back in the order the calls finished; vector i must land on text i",
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("refuses a vector of the wrong length", async () => {
    const model = new MockEmbeddingModelV4({
      doEmbed: async ({ values }) => ({ embeddings: values.map(() => [1, 0]), warnings: [] }),
    });
    const failure = await aiSdkEmbedder(model, { version: "mock@3", dimensions: 3 })
      .embed(["a"])
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure, "a 2-number vector was accepted: check each vector's length against `dimensions`").toBeInstanceOf(
      Error,
    );
    expect((failure as Error).message).toMatch(/mock@3 returned 2 dimensions, expected 3/);
  });

  it("reports the tokens of each batch as it goes", async () => {
    const { model } = numberModel();
    const reported: number[] = [];
    await aiSdkEmbedder(model, {
      version: "mock@3",
      dimensions: 3,
      batchSize: 2,
      onUsage: (tokens) => reported.push(tokens),
    }).embed(numbers(5));
    expect(reported, "call onUsage once per batch, with that batch's usage.tokens").toEqual([20, 20, 10]);
  });
});

describe("the worked example", () => {
  it("embeds the 434 recorded chunks in two calls of 256 and 178, 68,459 tokens, each vector on its own chunk", async () => {
    const chunks = recordedChunks();
    // A text that appears twice (the same policy in two folders) was embedded twice, a hair apart each time.
    const byText = new Map<string, number[][]>();
    for (const chunk of chunks) byText.set(chunk.text, [...(byText.get(chunk.text) ?? []), chunk.embedding]);
    const calls: number[] = [];
    // Plays OpenAI: its limits, the recorded vectors, and usage by our tokenizer's count.
    const model = new MockEmbeddingModelV4({
      maxEmbeddingsPerCall: 2048,
      doEmbed: async ({ values, dimensions }) => {
        const tokens = values.reduce((sum, value) => sum + countTokens(value), 0);
        if (values.length > 2048) throw new Error(`${values.length} inputs in one request; OpenAI takes 2,048`);
        if (tokens > 300_000) throw new Error(`${tokens} tokens in one request; OpenAI takes 300,000`);
        if (dimensions !== 1536) throw new Error(`asked for ${dimensions} dimensions`);
        calls.push(values.length);
        return { embeddings: values.map((value) => byText.get(value)!.shift()!), usage: { tokens }, warnings: [] };
      },
    });
    let tokens = 0;
    const embedder = aiSdkEmbedder(model, {
      version: "text-embedding-3-small@1536",
      dimensions: 1536,
      onUsage: (used) => (tokens += used),
    });
    const vectors = await embedder.embed(chunks.map((chunk) => chunk.text));

    expect(calls, `${DEFAULT_BATCH_SIZE} chunks a call`).toEqual([256, 178]);
    expect(tokens).toBe(68_459);
    expect(vectors.length).toBe(434);
    vectors.forEach((vector, i) => expect(vector, `chunk ${chunks[i].key}`).toBe(chunks[i].embedding));

    // The filing: 5,274 chunks in 21 calls, the last of 154, the largest 112,920 tokens.
    const filing = batches(filingTokenCounts().tokenCounts, DEFAULT_BATCH_SIZE);
    expect(filing.map((batch) => batch.length)).toEqual([...Array(20).fill(256), 154]);
    const sums = filing.map((batch) => batch.reduce((sum, n) => sum + n, 0));
    expect(sums.reduce((sum, n) => sum + n, 0)).toBe(2_104_091);
    expect(Math.max(...sums)).toBe(112_920);
  });
});
