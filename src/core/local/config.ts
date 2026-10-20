import { resolve } from "node:path";

type Env = Record<string, string | undefined>;

/**
 * Where the models run. `hosted` is OpenAI for chat and embeddings and Cohere for reranking, as the app has always
 * done. `local` is everything on this machine: chat and embeddings from LM Studio's OpenAI-compatible server, and
 * a cross-encoder reranker run in this process by transformers.js. Local never falls back to hosted: with
 * `MODEL_PROVIDER=local`, no OpenAI or Cohere client is built, even when their keys are set.
 */
export type ModelProvider = "hosted" | "local";

export function modelProvider(env: Env = process.env): ModelProvider {
  const value = env.MODEL_PROVIDER?.trim() || "hosted";
  if (value !== "hosted" && value !== "local") {
    throw new Error(`MODEL_PROVIDER must be "hosted" or "local"; got "${value}"`);
  }
  return value;
}

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

export const LOCAL_DEFAULTS = {
  baseURL: "http://127.0.0.1:1234/v1",
  chatModel: "qwen/qwen3-8b",
  embeddingModel: "text-embedding-nomic-embed-text-v1.5",
  embeddingDimensions: 768,
  rerankerModel: "Xenova/bge-reranker-base",
  rerankerDtype: "q8",
  weightsDir: "vendor/models",
} as const;

/** The local models, from the environment, with the defaults above. Relative paths are from the working directory,
 * which is the repo for every script and for `pnpm dev` and `pnpm start`. */
export function localConfig(env: Env = process.env): LocalConfig {
  const dimensions = Number(env.LOCAL_EMBEDDING_DIMENSIONS ?? LOCAL_DEFAULTS.embeddingDimensions);
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error(`LOCAL_EMBEDDING_DIMENSIONS must be a whole number; got "${env.LOCAL_EMBEDDING_DIMENSIONS}"`);
  }
  const dtype = env.LOCAL_RERANKER_DTYPE ?? LOCAL_DEFAULTS.rerankerDtype;
  if (dtype !== "fp32" && dtype !== "q8") throw new Error(`LOCAL_RERANKER_DTYPE must be fp32 or q8; got "${dtype}"`);
  return {
    baseURL: env.LMSTUDIO_BASE_URL || LOCAL_DEFAULTS.baseURL,
    chatModel: env.LOCAL_CHAT_MODEL || LOCAL_DEFAULTS.chatModel,
    embeddingModel: env.LOCAL_EMBEDDING_MODEL || LOCAL_DEFAULTS.embeddingModel,
    embeddingDimensions: dimensions,
    rerankerModel: env.LOCAL_RERANKER_MODEL || LOCAL_DEFAULTS.rerankerModel,
    rerankerDtype: dtype,
    weightsDir: resolve(env.LOCAL_WEIGHTS_DIR || LOCAL_DEFAULTS.weightsDir),
  };
}
