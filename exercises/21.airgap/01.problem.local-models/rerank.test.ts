// @vitest-environment node
import { Tensor, TextClassificationPipeline } from "@huggingface/transformers";
import { describe, expect, it } from "vitest";

import {
  type CrossEncoder,
  crossEncoderReranker,
  crossEncoderScores,
  RERANK_BATCH_SIZE,
  sigmoid,
} from "#learn/local/rerank";
import { RERANK_RECORDING, recordedEncoder, standInEncoder } from "@/core/local/recorded";

const LOGITS: Record<string, number> = { relevant: 3.2, related: 0.4, unrelated: -6.1 };
const byPassage = () => standInEncoder((_query, passage) => LOGITS[passage] ?? 0);

describe("sigmoid", () => {
  it("squashes a logit into (0, 1), with 0 at one half", () => {
    expect(sigmoid(0), "a logit of 0 is undecided: 0.5").toBe(0.5);
    expect(sigmoid(3.2), "1 / (1 + e^-3.2)").toBeCloseTo(0.9608, 4);
    expect(sigmoid(-6.1), "1 / (1 + e^6.1)").toBeCloseTo(0.00224, 5);
    expect(sigmoid(2) + sigmoid(-2), "the curve is symmetric: s(x) + s(-x) = 1").toBeCloseTo(1, 12);
  });

  it("gives a higher logit a higher score, and stays a number far from 0", () => {
    expect(sigmoid(1), "a higher logit means more relevant: 1 / (1 + e^-x), with the minus").toBeGreaterThan(
      sigmoid(-1),
    );
    expect(
      [sigmoid(1000), sigmoid(-1000)],
      "e^x / (1 + e^x) is the same curve, but e^1000 is Infinity and Infinity / Infinity is NaN: use e^-x",
    ).toEqual([1, 0]);
  });
});

describe("crossEncoderScores", () => {
  it("pairs the query with each passage through text_pair, so the model reads both at once", async () => {
    const { encoder, calls } = byPassage();
    await crossEncoderScores(encoder, "q", ["related", "relevant", "unrelated"], 3);
    expect(
      calls,
      "tokenize(queries, { text_pair }) pairs queries[i] with text_pair[i]: the query once per passage",
    ).toEqual([{ queries: ["q", "q", "q"], pairs: ["related", "relevant", "unrelated"] }]);
  });

  it("scores each passage with the sigmoid of its own logit, in the order the passages came", async () => {
    const { encoder } = byPassage();
    const scores = await crossEncoderScores(encoder, "q", ["related", "relevant", "unrelated"], 3);
    expect(scores, "one score per passage, in the passages' order (crossEncoderReranker does the sorting)").toEqual(
      [sigmoid(0.4), sigmoid(3.2), sigmoid(-6.1)].map((score) => expect.closeTo(score, 6)),
    );
  });

  it("goes batchSize passages at a time, one pair per pass by default", async () => {
    const batched = byPassage();
    const scores = await crossEncoderScores(batched.encoder, "q", ["a", "b", "c", "d", "e"], 2);
    expect(
      batched.calls.map((call) => call.pairs.length),
      "five passages in batches of 2 are three passes",
    ).toEqual([2, 2, 1]);
    expect(scores).toHaveLength(5);

    const single = byPassage();
    await crossEncoderScores(single.encoder, "q", ["a", "b", "c"]);
    expect(
      single.calls.map((call) => call.pairs.length),
      `the default batch is RERANK_BATCH_SIZE (${RERANK_BATCH_SIZE})`,
    ).toEqual([1, 1, 1]);
  });

  it("refuses a model that doesn't give one logit per pair", async () => {
    const twoLabels: CrossEncoder = {
      tokenize: (_queries, options) => options.text_pair,
      classify: async () => ({ logits: new Tensor("float32", new Float32Array([0.1, 2, -1, 3]), [2, 2]) }),
    };
    const error = await crossEncoderScores(twoLabels, "q", ["a", "b"], 2).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(
      error instanceof Error ? error.message : "no error",
      "a classifier with two labels answers [2, 2]: check logits.dims is [batch, 1], and throw when it isn't",
    ).toMatch(/one logit per pair/);
  });

  it("tells passages apart where transformers.js's pipeline scores every one 1.0", async () => {
    const passages = ["relevant", "related", "unrelated"];
    // bge-reranker's config: one label and no problem_type, so the pipeline takes it for a single-label softmax.
    const model = Object.assign(
      async (inputs: string[]) => ({
        logits: new Tensor("float32", Float32Array.from(inputs.map((text) => LOGITS[text] ?? 0)), [inputs.length, 1]),
      }),
      { config: { id2label: { 0: "LABEL_0" } } },
    );
    const pipeline = new TextClassificationPipeline({
      task: "text-classification",
      model: model as never,
      tokenizer: ((texts: string[]) => texts) as never,
    });
    const viaPipeline = (await pipeline(passages)) as { score: number }[];
    expect(viaPipeline.map((entry) => entry.score)).toEqual([1, 1, 1]);

    const scores = await crossEncoderScores(byPassage().encoder, "q", passages);
    expect(new Set(scores).size, "three logits, three different scores").toBe(3);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
  });

  it("scores the London hotel question's four recorded chunks 0.959, 0.976, 0.844 and 0.00004", async () => {
    const { query, passages } = RERANK_RECORDING;
    const texts = passages.map((passage) => passage.text);
    const scores = await crossEncoderScores(recordedEncoder().encoder, query, texts);
    expect(
      scores.map((score) => Number(score.toFixed(3))),
      "each score is the sigmoid of the recorded logit: 3.146, 3.694, 1.689, -10.181",
    ).toEqual([0.959, 0.976, 0.844, 0]);
    expect(scores[3], "the Brightwell contacts table: a logit of -10.18").toBeCloseTo(0.0000379, 7);

    const reranker = crossEncoderReranker(async () => recordedEncoder().encoder, "local/recorded");
    const ranked = await reranker.rerank(query, texts, 4);
    expect(
      ranked.map((entry) => `${passages[entry.index]!.path.split("/").at(-1)} p${passages[entry.index]!.page}`),
      "version 1 edges version 2: the conflicting-sources trap, as the golden eval found it",
    ).toEqual([
      "Travel and Expenses Policy.pdf p2",
      "Travel and Expenses Policy v2.pdf p2",
      "Travel and Expenses Policy v2.pdf p4",
      "Brightwell Payroll Partner Onboarding Pack v1.3.docx pnull",
    ]);
    expect(
      passages.map((passage) => passage.pipeline),
      "what the pipeline said for the same pairs, on the same weights",
    ).toEqual([1, 1, 1, 1]);
  });
});
