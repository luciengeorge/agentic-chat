// 👨‍💼 The HNSW index over Kestrel's chunks is 44 MB, and it has to sit in memory to be fast. A quarter of the
//    dimensions would make it a sixth of the size. text-embedding-3 vectors are built so that their first numbers
//    carry the most meaning, so keeping only those is a real option. It's also an easy one to get subtly wrong.

/**
 * text-embedding-3 vectors truncated to their first `dimensions` numbers, ready to compare with cosine similarity
 * or inner product.
 */
export function truncateEmbedding(embedding: readonly number[], dimensions: number): number[] {
  // 🐨 Refuse (with a RangeError) a `dimensions` that isn't a whole number from 1 to the embedding's length.
  // 🐨 Keep the first `dimensions` numbers.
  // 🐨 Scale that prefix back to length 1: divide every number by the prefix's own length (refuse a prefix that's
  //    all zeros, which has no direction to keep).
  //
  // 💰 `embedding.slice(0, n)`, `Math.hypot(...numbers)` is the length (the square root of the sum of squares),
  //    `numbers.map((x) => x / length)`.
  //
  // 🦉 Why a prefix means anything. OpenAI trained text-embedding-3 with Matryoshka representation learning: the
  //    model was scored on its first 64, 128, 256... numbers as well as on all 1,536, so the start of the vector
  //    holds the coarse meaning and later numbers add detail. Cut an ordinary embedding in half and you'd keep
  //    noise; cut one of these and you keep a blurrier version of the same meaning.
  // 🦉 Why rescale, the classic mistake. The whole vector has length 1, so a prefix is shorter: the first 256
  //    numbers of "What is the nightly limit for a hotel in London?" have length 0.4719, and the chunks' prefixes
  //    range from 0.4390 to 0.5622. Cosine similarity divides by both lengths, so it wouldn't notice. But the
  //    fastest comparison, the inner product (pgvector's `<#>`, and OpenAI's advice for its unit vectors), doesn't
  //    divide: an unscaled prefix that happens to be longer scores higher for no reason to do with meaning. On the
  //    recorded chunks that reorders the top 10 of 32 of the 46 golden questions, and costs 3 points of recall.
  // 🦉 Why the same length for every number. Dividing every number by one length shrinks or stretches the vector
  //    without turning it, so its direction (its meaning) is untouched.
  //
  // 📜 https://openai.com/index/new-embedding-models-and-api-updates/ (shortening embeddings)
  // 📜 https://arxiv.org/abs/2205.13147 (Matryoshka representation learning)
  //
  // 🚨 The tests check that a prefix comes back at length 1 pointing the same way, that bad sizes and all-zero
  //    prefixes are refused, that inner product over your prefixes ranks every golden question exactly as cosine
  //    does, and the worked example: 256 dimensions keep 77.0% of the true top 10 over the recorded chunks.
  throw new Error(`truncateEmbedding(${embedding.length} dimensions to ${dimensions}) isn't written yet`);
}
