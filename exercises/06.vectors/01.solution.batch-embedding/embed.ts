import { embedMany, type EmbeddingModel } from "ai";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

/** Turns text into vectors. `version` names the model and its dimensions: vectors are compared only with vectors
 * of the same version, so it's stored beside every embedding (`chunks.embedding_model_version`). */
export interface Embedder {
  version: string;
  dimensions: number;
  embed(values: string[]): Promise<number[][]>;
}

/** OpenAI takes at most 2,048 inputs and 300,000 tokens per request. Chunks hold about 512 tokens, so 256 of them
 * stay well under both. */
export const DEFAULT_BATCH_SIZE = 256;

export function batches<T>(values: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`batch size must be a positive integer, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** An embedder on any AI SDK embedding model, one `embedMany` call per batch. */
export function aiSdkEmbedder(
  model: EmbeddingModel,
  options: {
    version: string;
    dimensions: number;
    batchSize?: number;
    maxParallelCalls?: number;
    /** Called after each batch with the tokens the provider counted (and bills). */
    onUsage?: (tokens: number) => void;
  },
): Embedder {
  const { version, dimensions, batchSize = DEFAULT_BATCH_SIZE, maxParallelCalls = 4, onUsage } = options;
  return {
    version,
    dimensions,
    async embed(values) {
      const out: number[][] = [];
      for (const batch of batches(values, batchSize)) {
        const { embeddings, usage } = await embedMany({ model, values: batch, dimensions, maxParallelCalls });
        onUsage?.(usage.tokens);
        for (const embedding of embeddings) {
          if (embedding.length !== dimensions) {
            throw new Error(`${version} returned ${embedding.length} dimensions, expected ${dimensions}`);
          }
          out.push(embedding);
        }
      }
      return out;
    },
  };
}
