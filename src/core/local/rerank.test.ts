// @vitest-environment node
import { Tensor, TextClassificationPipeline } from "@huggingface/transformers";
import { describe, expect, it } from "vitest";

import { type CrossEncoder, crossEncoderReranker, crossEncoderScores, sigmoid } from "./rerank";

/**
 * A stand-in cross-encoder with one output logit, as bge-reranker has: the logit is fixed per passage, so the
 * tests know the answer. The tokenizer records what it was given.
 */
function fakeEncoder(logitOf: (passage: string) => number) {
  const seen: { queries: string[]; pairs: string[] }[] = [];
  const encoder: CrossEncoder = {
    tokenize(queries, options) {
      seen.push({ queries, pairs: options.text_pair });
      return options.text_pair;
    },
    async classify(inputs) {
      const passages = inputs as string[];
      return { logits: new Tensor("float32", Float32Array.from(passages.map(logitOf)), [passages.length, 1]) };
    },
  };
  return { encoder, seen };
}

const LOGITS: Record<string, number> = { relevant: 3.2, related: 0.4, unrelated: -6.1 };
const logitOf = (passage: string) => LOGITS[passage] ?? 0;

describe("sigmoid", () => {
  it("maps a logit into (0, 1), with 0 at a half", () => {
    expect(sigmoid(0)).toBe(0.5);
    expect(sigmoid(3.2)).toBeCloseTo(0.9608, 4);
    expect(sigmoid(-6.1)).toBeCloseTo(0.00224, 5);
  });
});

describe("crossEncoderScores", () => {
  it("pairs the query with each passage and puts each logit through a sigmoid", async () => {
    const { encoder, seen } = fakeEncoder(logitOf);
    const scores = await crossEncoderScores(encoder, "q", ["related", "relevant", "unrelated"], 3);
    expect(seen).toEqual([{ queries: ["q", "q", "q"], pairs: ["related", "relevant", "unrelated"] }]);
    expect(scores).toEqual([sigmoid(0.4), sigmoid(3.2), sigmoid(-6.1)].map((x) => expect.closeTo(x, 6)));
  });

  it("scores in batches", async () => {
    const { encoder, seen } = fakeEncoder(logitOf);
    const scores = await crossEncoderScores(encoder, "q", ["a", "b", "c", "d", "e"], 2);
    expect(seen.map((call) => call.pairs.length)).toEqual([2, 2, 1]);
    expect(scores).toHaveLength(5);
  });

  it("refuses a model with more than one logit per pair", async () => {
    const encoder: CrossEncoder = {
      tokenize: () => null,
      classify: async () => ({ logits: new Tensor("float32", new Float32Array(4), [2, 2]) }),
    };
    await expect(crossEncoderScores(encoder, "q", ["a", "b"], 2)).rejects.toThrow("[2, 1]; got [2, 2]");
  });
});

describe("crossEncoderReranker", () => {
  it("returns the best topN, best first, ties in the order they came", async () => {
    const { encoder } = fakeEncoder(logitOf);
    const reranker = crossEncoderReranker(async () => encoder, "local/fake");
    const ranked = await reranker.rerank("q", ["unrelated", "tie", "relevant", "tie"], 3);
    expect(ranked.map((entry) => entry.index)).toEqual([2, 1, 3]);
    expect(ranked[0].score).toBeCloseTo(sigmoid(3.2), 6);
  });

  it("doesn't load the model for nothing", async () => {
    const reranker = crossEncoderReranker(async () => {
      throw new Error("loaded");
    }, "local/fake");
    expect(await reranker.rerank("q", [], 5)).toEqual([]);
  });
});

describe("the pipeline API's trap", () => {
  it("scores every passage 1.0 for a one-logit model, where the sigmoid tells them apart", async () => {
    const passages = ["relevant", "related", "unrelated"];
    const model = Object.assign(
      async (inputs: string[]) => ({
        logits: new Tensor("float32", Float32Array.from(inputs.map(logitOf)), [inputs.length, 1]),
      }),
      // bge-reranker's config: one label, no problem_type, so the pipeline takes it for single-label softmax.
      { config: { id2label: { 0: "LABEL_0" } } },
    );
    const tokenizer = (texts: string[]) => texts;
    const classify = new TextClassificationPipeline({
      task: "text-classification",
      model: model as never,
      tokenizer: tokenizer as never,
    });

    const viaPipeline = (await classify(passages)) as { label: string; score: number }[];
    expect(viaPipeline.map((entry) => entry.score)).toEqual([1, 1, 1]);

    const { encoder } = fakeEncoder(logitOf);
    const direct = await crossEncoderScores(encoder, "q", passages);
    expect(new Set(direct).size).toBe(3);
    expect(direct[0]).toBeGreaterThan(direct[1]);
    expect(direct[1]).toBeGreaterThan(direct[2]);
  });
});
