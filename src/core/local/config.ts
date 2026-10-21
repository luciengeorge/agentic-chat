import { resolve } from "node:path";

import { LOCAL_DEFAULTS, localChatConfig } from "#learn/local/provider";

export { LOCAL_DEFAULTS, localChatConfig, type ModelProvider, modelProvider } from "#learn/local/provider";

type Env = Record<string, string | undefined>;

export interface LocalConfig {
  /** LM Studio's OpenAI-compatible API, `/v1` included. */
  baseURL: string;
  /** The chat model's identifier in LM Studio (`lms ps`). */
  chatModel: string;
  /** The embedding model's identifier in LM Studio. */
  embeddingModel: string;
  /** What the embedding model returns. The column holds 1,536, so a shorter vector is padded with zeros. */
  embeddingDimensions: number;
  /** The reranker's Hugging Face repo id, as a folder under `weightsDir`. */
  rerankerModel: string;
  /** Which ONNX file transformers.js loads: `q8` is `onnx/model_quantized.onnx`. */
  rerankerDtype: "fp32" | "q8";
  /** The vendored weights (`pnpm local:weights` fetches them). The repo ignores this folder. */
  weightsDir: string;
}

/** The local models, from the environment, with `LOCAL_DEFAULTS` (`#learn/local/provider`). Relative paths are
 * from the working directory, which is the repo for every script and for `pnpm dev` and `pnpm start`. */
export function localConfig(env: Env = process.env): LocalConfig {
  const dimensions = Number(env.LOCAL_EMBEDDING_DIMENSIONS ?? LOCAL_DEFAULTS.embeddingDimensions);
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error(`LOCAL_EMBEDDING_DIMENSIONS must be a whole number; got "${env.LOCAL_EMBEDDING_DIMENSIONS}"`);
  }
  const dtype = env.LOCAL_RERANKER_DTYPE ?? LOCAL_DEFAULTS.rerankerDtype;
  if (dtype !== "fp32" && dtype !== "q8") throw new Error(`LOCAL_RERANKER_DTYPE must be fp32 or q8; got "${dtype}"`);
  return {
    ...localChatConfig(env),
    embeddingModel: env.LOCAL_EMBEDDING_MODEL || LOCAL_DEFAULTS.embeddingModel,
    embeddingDimensions: dimensions,
    rerankerModel: env.LOCAL_RERANKER_MODEL || LOCAL_DEFAULTS.rerankerModel,
    rerankerDtype: dtype,
    weightsDir: resolve(env.LOCAL_WEIGHTS_DIR || LOCAL_DEFAULTS.weightsDir),
  };
}
