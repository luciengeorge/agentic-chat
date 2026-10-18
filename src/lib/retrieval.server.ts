import { createCohere } from "@ai-sdk/cohere";
import { createOpenAI } from "@ai-sdk/openai";

import type { Retrieve } from "#learn/retrieve/types";

import { aiSdkEmbedder, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, type Embedder } from "#learn/embed/embed";
import { hashingEmbedder } from "#learn/embed/fake";
import { aiSdkChatModel } from "#learn/model/ai-sdk";
import { CHAT_MODEL, CHAT_REASONING_EFFORT } from "#learn/model/config";
import { modelRewriter, noRewriter, type QueryRewriter } from "#learn/query/rewrite";
import { aiSdkReranker, overlapReranker, type Reranker } from "#learn/rerank/rerank";
import { createRetrieve } from "#learn/retrieve/retrieve";
import { withTenant } from "@/db/tenant";
import { acEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";

const logger = createLogger("retrieval");

/** Unverified until there's a Cohere key: the id the AI SDK's Cohere provider sends. */
export const COHERE_RERANK_MODEL = "rerank-v4.0-fast";

type Env = Record<string, string | undefined>;

let warned = false;
function warnFake(what: string) {
  if (warned) return;
  warned = true;
  logger.warn("no OPENAI_API_KEY: using deterministic fakes", { what });
}

/**
 * OpenAI's text-embedding-3-small at 1,536 dimensions when OPENAI_API_KEY is set. Tests always get the hashing
 * fake, so they never call out; dev without a key gets it too. Production without a key refuses to start
 * embedding: fake vectors would make search look like it works.
 */
export function embedderFromEnv(
  env: Env = process.env,
  options: { onUsage?: (tokens: number) => void } = {},
): Embedder {
  const mode = acEnv(env);
  if (mode !== "test" && env.OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
    return aiSdkEmbedder(openai.embedding(EMBEDDING_MODEL), {
      version: `${EMBEDDING_MODEL}@${EMBEDDING_DIMENSIONS}`,
      dimensions: EMBEDDING_DIMENSIONS,
      onUsage: options.onUsage,
    });
  }
  if (mode === "prod") throw new Error("OPENAI_API_KEY must be set to embed in production");
  if (mode === "dev") warnFake("embeddings");
  return hashingEmbedder(EMBEDDING_DIMENSIONS);
}

/** Cohere when COHERE_API_KEY is set (never in tests), else the deterministic overlap reranker. */
export function rerankerFromEnv(env: Env = process.env): Reranker {
  if (acEnv(env) !== "test" && env.COHERE_API_KEY) {
    const cohere = createCohere({ apiKey: env.COHERE_API_KEY });
    return aiSdkReranker(cohere.reranking(COHERE_RERANK_MODEL), `cohere/${COHERE_RERANK_MODEL}`);
  }
  return overlapReranker();
}

/** The chat model, at its explicit effort, rewrites queries when OPENAI_API_KEY is set (never in tests).
 * Otherwise retrieval searches the question alone. */
export function rewriterFromEnv(env: Env = process.env): QueryRewriter {
  if (acEnv(env) !== "test" && env.OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
    return modelRewriter(aiSdkChatModel(openai(CHAT_MODEL)), CHAT_REASONING_EFFORT);
  }
  return noRewriter;
}

/** `retrieve` for the app: the viewer from `getViewer()`, the dependencies from the environment. Server only. */
export const retrieve: Retrieve = (viewer, query, options) =>
  createRetrieve({
    withTenant,
    embedder: embedderFromEnv(),
    reranker: rerankerFromEnv(),
    rewriter: rewriterFromEnv(),
  })(viewer, query, options);
