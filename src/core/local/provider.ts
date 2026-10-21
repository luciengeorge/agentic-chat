type Env = Record<string, string | undefined>;

/**
 * Where the models run. `hosted` is OpenAI for chat and embeddings and Cohere for reranking, as the app has always
 * done. `local` is everything on this machine: chat and embeddings from LM Studio's OpenAI-compatible server, and
 * a cross-encoder reranker run in this process by transformers.js. Local never falls back to hosted: with
 * `MODEL_PROVIDER=local`, no OpenAI or Cohere client is built, even when their keys are set.
 *
 * This file imports nothing from Node, so a workflow bundle can read the switch (`src/workflows/workflow-agent.ts`).
 */
export type ModelProvider = "hosted" | "local";

export function modelProvider(env: Env = process.env): ModelProvider {
  const value = env.MODEL_PROVIDER?.trim() || "hosted";
  if (value !== "hosted" && value !== "local") {
    throw new Error(`MODEL_PROVIDER must be "hosted" or "local"; got "${value}"`);
  }
  return value;
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

/** LM Studio's address and chat model, from the environment, with the defaults above. */
export function localChatConfig(env: Env = process.env): { baseURL: string; chatModel: string } {
  return {
    baseURL: env.LMSTUDIO_BASE_URL || LOCAL_DEFAULTS.baseURL,
    chatModel: env.LOCAL_CHAT_MODEL || LOCAL_DEFAULTS.chatModel,
  };
}
