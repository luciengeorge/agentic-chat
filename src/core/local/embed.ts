import { type EmbeddingModel, embedMany } from "ai";

import { batches, EMBEDDING_DIMENSIONS, type Embedder } from "#learn/embed/embed";

/** What a text is embedded as. Retrieval embeds queries; ingest and `pnpm db:embed` embed documents. */
export type EmbedPurpose = "query" | "document";

/**
 * nomic-embed-text was trained with a task prefix on every input, and its model card says to send one: a query
 * and the passage that answers it land closer when each says what it is. OpenAI's models take none.
 */
export const NOMIC_PREFIXES: Record<EmbedPurpose, string> = {
  query: "search_query: ",
  document: "search_document: ",
};

/** LM Studio embeds one input at a time; 32 per request keeps a request short without a call per chunk. */
export const LOCAL_BATCH_SIZE = 32;

/**
 * Pads a vector with zeros to `length`. Cosine similarity and Euclidean distance are unchanged by it: the zeros
 * add nothing to a dot product or a norm. So a 768-dimension vector can live in the 1,536-dimension column and
 * be searched exactly as it was, as long as it's only ever compared with vectors of its own model.
 */
export function padVector(vector: number[], length: number): number[] {
  if (vector.length > length) throw new RangeError(`can't pad ${vector.length} dimensions down to ${length}`);
  if (vector.length === length) return vector;
  return [...vector, ...Array.from<number>({ length: length - vector.length }).fill(0)];
}

/**
 * An embedder on a local model with fewer dimensions than the column. `version` names the model and its real
 * dimension (`text-embedding-nomic-embed-text-v1.5@768`), so the vector search, which compares a query only with
 * chunks of the same version, can never mix it with OpenAI's vectors; `dimensions` is what's stored. The prefix
 * for `purpose` goes on every input. A model that returns another length is an error, never padded or cut.
 */
export function localEmbedder(
  model: EmbeddingModel,
  options: {
    modelId: string;
    dimensions: number;
    purpose: EmbedPurpose;
    prefixes?: Record<EmbedPurpose, string>;
    storedDimensions?: number;
    batchSize?: number;
  },
): Embedder {
  const {
    modelId,
    dimensions,
    purpose,
    prefixes = NOMIC_PREFIXES,
    storedDimensions = EMBEDDING_DIMENSIONS,
    batchSize = LOCAL_BATCH_SIZE,
  } = options;
  if (dimensions > storedDimensions) {
    throw new RangeError(`${modelId} has ${dimensions} dimensions; the column holds ${storedDimensions}`);
  }
  const version = `${modelId}@${dimensions}`;
  return {
    version,
    dimensions: storedDimensions,
    async embed(values) {
      const out: number[][] = [];
      for (const batch of batches(values, batchSize)) {
        const { embeddings } = await embedMany({
          model,
          values: batch.map((value) => prefixes[purpose] + value),
          maxParallelCalls: 1,
        });
        for (const embedding of embeddings) {
          if (embedding.length !== dimensions) {
            throw new Error(`${version} returned ${embedding.length} dimensions, expected ${dimensions}`);
          }
          out.push(padVector(embedding, storedDimensions));
        }
      }
      return out;
    },
  };
}
