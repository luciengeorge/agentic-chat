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
  return 1 / (1 + Math.exp(-x));
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
  const scores: number[] = [];
  for (let start = 0; start < documents.length; start += batchSize) {
    const batch = documents.slice(start, start + batchSize);
    const inputs = encoder.tokenize(
      batch.map(() => query),
      { text_pair: [...batch], padding: true, truncation: true },
    );
    const { logits } = await encoder.classify(inputs);
    if (logits.dims.length !== 2 || logits.dims[0] !== batch.length || logits.dims[1] !== 1) {
      throw new Error(`expected one logit per pair, [${batch.length}, 1]; got [${logits.dims.join(", ")}]`);
    }
    for (let i = 0; i < batch.length; i++) scores.push(sigmoid(Number(logits.data[i])));
  }
  return scores;
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
