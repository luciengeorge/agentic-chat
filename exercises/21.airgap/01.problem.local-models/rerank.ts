// 👨‍💼 Kestrel's compliance team has a question from its regulator: can the assistant run with no document leaving
//    Kestrel's network? Chat and embeddings can move to LM Studio on the same machine. The reranker is harder:
//    Cohere's is a hosted API, so its replacement has to run inside the app, on the CPU, from weights on disk.

import type { LocalConfig } from "#learn/local/config";
import type { Ranked, Reranker } from "#learn/rerank/rerank";

/** A tensor as transformers.js returns it: flat data, and its shape. */
export interface Logits {
  data: ArrayLike<number | bigint>;
  dims: number[];
}

/**
 * The two halves of a cross-encoder, as transformers.js gives them. The tokenizer joins each query with its
 * passage (`text_pair`) into one input, so the model reads both at once: that's what makes it a cross-encoder.
 * The model returns one logit per pair, a raw score with no fixed range.
 */
export interface CrossEncoder {
  tokenize(queries: string[], options: { text_pair: string[]; padding: true; truncation: true }): unknown;
  classify(inputs: unknown): Promise<{ logits: Logits }>;
}

/** Squashes a logit into (0, 1): 1 / (1 + e^-x). A logit of 0 is 0.5; higher means more relevant. */
export function sigmoid(x: number): number {
  // 🐨 Return 1 / (1 + e^-x).
  //
  // 💰 `Math.exp(n)` is e^n.
  //
  // 🦉 Why a sigmoid, and never a softmax. A softmax turns a row of logits into shares that add up to 1: each
  //    e^x divided by the row's total. That's right for a classifier with several labels ("spam", "not spam"),
  //    where the shares are the labels' chances. A reranker has one label, so each row holds one logit, and
  //    e^x / e^x is 1 for every document. A sigmoid squashes one number on its own: it never looks at another
  //    document, it keeps the order of the logits, and 0.5 means the model is undecided.
  // 🦉 The form matters at the edges. e^x / (1 + e^x) is the same curve on paper, but e^x is Infinity past
  //    x = 709, and Infinity / Infinity is NaN. With e^-x, a huge logit gives 1 / (1 + 0) and a hugely negative
  //    one 1 / Infinity, which is 0.
  throw new Error(`sigmoid(${x}) isn't written yet`);
}

/** Pairs scored per forward pass. One at a time was the fastest on an M4's CPU (`pnpm local:bench`: 30 pairs in
 * 2.3 to 4.9 s, against 4.6 to 6.8 s in batches of 4 to 30): a batch pads every pair to its longest, and
 * onnxruntime already spreads one pass over the cores. The int8 model quantizes activations per batch, so a
 * pair's score also shifts a little with the pairs beside it; one at a time, it doesn't. */
export const RERANK_BATCH_SIZE = 1;

/**
 * Scores each document against the query: one logit per pair, through a sigmoid. Not softmax: softmax turns a
 * row into shares that sum to 1, and a row of one logit is always [1.0]. transformers.js's text-classification
 * pipeline applies exactly that softmax to a model with one label, which is why it scores every document 1.0.
 */
export async function crossEncoderScores(
  encoder: CrossEncoder,
  query: string,
  documents: readonly string[],
  batchSize = RERANK_BATCH_SIZE,
): Promise<number[]> {
  // 🐨 Go through `documents` `batchSize` at a time, in order. For each batch:
  //    1. tokenize it: the queries are the query once per document in the batch, and `text_pair` is the batch
  //       itself, with `padding: true` and `truncation: true`;
  //    2. run the model on what the tokenizer gave you (`encoder.classify`);
  //    3. check the logits' shape is [the batch's length, 1], and throw an Error saying "expected one logit per
  //       pair" when it isn't;
  //    4. push the sigmoid of each logit, in the batch's order.
  //    Return every score, in the documents' order. Sorting is `crossEncoderReranker`'s job, below.
  //
  // 🐨 The classic mistakes, all three silent: passing the query once (`[query]`) for a batch of several
  //    documents; gluing query and document into one string instead of using `text_pair`; and a softmax where
  //    the sigmoid goes.
  //
  // 💰 `documents.slice(start, start + batchSize)`; `batch.map(() => query)`; `logits.dims` is an array like
  //    `[4, 1]`; `logits.data[i]` may be a bigint, so read it with `Number(...)`.
  //
  // 🦉 Why `text_pair`, and not one joined string. A cross-encoder reads the query and the document together, in
  //    one input, so every word of one can be weighed against every word of the other (the "librarian who opens
  //    each book"). The tokenizer builds that input as `<s> query </s></s> document </s>`: the separator tokens
  //    are how the model knows where the question stops. A string glued with a space has none, so the model
  //    reads one long text, and the scores drift.
  // 🦉 Why check the shape. A classifier with two labels returns [n, 2]. Reading `data[i]` from that would score
  //    document 1 with document 0's second logit, and nothing would fail. One logit per pair is what makes this
  //    a reranker; anything else is an error worth stopping on.
  // 🦉 Why one pair per pass by default (`RERANK_BATCH_SIZE`). A batch pads every pair to the longest in it, so
  //    short chunks pay for long ones. And this model is int8 (its activations are rounded per batch), so a
  //    chunk's score depends a little on its neighbours: in batches of 8, the golden set's MRR was 0.899; one at a
  //    time, 0.887.
  //
  // 📜 https://huggingface.co/BAAI/bge-reranker-base (the model, and "use sigmoid to map the score to [0, 1]")
  //
  // 🚨 The tests check the sigmoid's values and its edges, that each passage is paired with the query through
  //    `text_pair`, the batches, the shape check, that the scores keep the documents' order, that transformers.js's
  //    pipeline really does say 1.0 for every passage, and the London hotel question's recorded logits: 0.976,
  //    0.959, 0.844 and 0.00004.
  throw new Error(
    `crossEncoderScores(${typeof encoder}, "${query}", ${documents.length} documents, batches of ${batchSize}) isn't written yet`,
  );
}

/** A reranker on a cross-encoder: every document scored, best first, ties in the order they came (fused order). */
export function crossEncoderReranker(
  load: () => Promise<CrossEncoder>,
  name: string,
  options: { batchSize?: number } = {},
): Reranker {
  return {
    name,
    async rerank(query, documents, topN): Promise<Ranked[]> {
      if (documents.length === 0) return [];
      const scores = await crossEncoderScores(await load(), query, documents, options.batchSize);
      return scores
        .map((score, index) => ({ index, score }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, topN);
    },
  };
}

const LOADED = Symbol.for("agentic-chat.local-cross-encoder");

/**
 * Loads the vendored cross-encoder with transformers.js, called directly: `AutoTokenizer` and
 * `AutoModelForSequenceClassification`, never `pipeline()`. Remote models are switched off, so a missing file is
 * an error naming the folder, never a download. One load per process and model (about a second for bge-reranker-
 * base), kept on `globalThis` so a module reload in dev doesn't load it twice.
 */
export function loadCrossEncoder(
  config: Pick<LocalConfig, "rerankerModel" | "rerankerDtype" | "weightsDir">,
): Promise<CrossEncoder> {
  const cache = ((globalThis as Record<symbol, unknown>)[LOADED] ??= new Map()) as Map<string, Promise<CrossEncoder>>;
  const key = `${config.weightsDir}|${config.rerankerModel}|${config.rerankerDtype}`;
  let loaded = cache.get(key);
  if (!loaded) {
    loaded = (async () => {
      const { AutoModelForSequenceClassification, AutoTokenizer, env } = await import("@huggingface/transformers");
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = `${config.weightsDir}/`;
      try {
        const tokenizer = await AutoTokenizer.from_pretrained(config.rerankerModel);
        const model = await AutoModelForSequenceClassification.from_pretrained(config.rerankerModel, {
          dtype: config.rerankerDtype,
        });
        return {
          tokenize: (queries, options) => tokenizer(queries, options),
          classify: (inputs) => model(inputs as Parameters<typeof model>[0]) as Promise<{ logits: Logits }>,
        };
      } catch (error) {
        throw new Error(
          `couldn't load ${config.rerankerModel} from ${config.weightsDir}; run \`pnpm local:weights\` (${(error as Error).message})`,
          { cause: error },
        );
      }
    })();
    cache.set(key, loaded);
    loaded.catch(() => cache.delete(key));
  }
  return loaded;
}

/** The local reranker the app uses with `MODEL_PROVIDER=local`. The weights load on the first rerank. */
export function localReranker(config: Pick<LocalConfig, "rerankerModel" | "rerankerDtype" | "weightsDir">): Reranker {
  return crossEncoderReranker(() => loadCrossEncoder(config), `local/${config.rerankerModel}@${config.rerankerDtype}`);
}
