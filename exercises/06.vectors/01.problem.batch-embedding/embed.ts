// 👨‍💼 Every chunk Kestrel ingests is embedded before search can find it by meaning: 434 chunks for the everyday
//    documents, 5,274 more for the regulatory filing. One HTTP call per chunk would be thousands of round trips
//    and thousands of chances to hit a rate limit. So the embedder sends them in batches, and it must hand every
//    vector back to the chunk it belongs to.

import type { EmbeddingModel } from "ai";

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
  // 🐨 Refuse a size that isn't a whole number of at least 1 (throw a RangeError): a size of 0 would loop forever.
  // 🐨 Cut `values` into runs of `size`, in order. The last run holds whatever is left, so it may be shorter.
  //    Nothing is dropped, and an empty list gives no runs at all.
  //
  // 💰 `values.slice(start, end)` copies a run; an `end` past the last index just stops there.
  //    `Number.isInteger(size)`.
  //
  // 🦉 Why the last run is the classic mistake. A loop that only takes full runs (`i + size <= values.length`)
  //    looks right on 512 chunks and quietly leaves the last 178 of 434 unembedded. Nothing fails: those chunks
  //    just never show up in a vector search.
  throw new Error(`batches(${values.length} values, size ${size}) isn't written yet`);
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
      // 🐨 For each batch of `values` (your `batches`, `batchSize` long), one call to the model, waiting for each
      //    before the next: `embedMany` with the model, the batch, `dimensions` and `maxParallelCalls`.
      // 🐨 After each call, report its `usage.tokens` through `onUsage` (it may be undefined).
      // 🐨 Check every vector that comes back has exactly `dimensions` numbers; if one doesn't, throw an Error
      //    that says `<version> returned <n> dimensions, expected <dimensions>`. Then add it to the list you return.
      //
      // 💰 Add `embedMany` to the import from "ai". It takes `{ model, values, dimensions, maxParallelCalls }` and
      //    resolves to `{ embeddings, usage }`: `embeddings[i]` is the vector of `values[i]`. `onUsage?.(n)` calls
      //    it only when it's there.
      //
      // 🦉 Why order is everything. A vector carries no label: nothing in 1,536 numbers says which chunk they came
      //    from. The only link is position, so vector i must land on chunk i. Firing every batch at once and pushing
      //    each batch's vectors as it arrives puts them in the order the calls finish, and every chunk after the
      //    first slow batch gets a neighbour's meaning. Search then returns confident, wrong chunks, and no error
      //    ever says so.
      // 🦉 Why one batch at a time. One request in flight stays inside the provider's rate limit (requests and
      //    tokens a minute); 21 at once for the filing can earn a 429. And a failure stops the loop, so the batches
      //    after it are never sent or paid for.
      // 🦉 Why check the length. A model asked for 1,536 numbers that returns 3,072 (a different model, a missing
      //    `dimensions`) would be refused by `vector(1536)` only at write time, after you've paid. A vector of the
      //    wrong size from a fake or a proxy might never be refused at all. Failing here, loudly, is cheapest.
      // 🦉 Why 256 a batch. OpenAI takes up to 2,048 inputs and 300,000 tokens a request. Chunks are at most 512
      //    tokens, so 256 of them can't pass 131,072 tokens, well under the token cap, whatever the chunks hold.
      //    The filing's largest batch is 112,920.
      //
      // 📜 https://ai-sdk.dev/docs/ai-sdk-core/embeddings (embedMany)
      // 📜 https://platform.openai.com/docs/api-reference/embeddings/create (the limits)
      //
      // 🚨 The tests check that `batches` keeps every value in order with a shorter last run, that each batch is one
      //    call with the dimensions passed, that vectors come back in input order even when a later call answers
      //    first, that a vector of the wrong length is refused, that usage is reported per batch, and that the 434
      //    recorded chunks go in two calls (256 and 178) and come back as their recorded vectors.
      throw new Error(
        `${version}.embed(${values.length} values on a ${typeof model} model, batches of ${batchSize}, ` +
          `${maxParallelCalls} in parallel, ` +
          `${onUsage ? "with" : "without"} usage, ${dimensions} dimensions) isn't written yet`,
      );
    },
  };
}
