/**
 * text-embedding-3 models are trained so a vector's first dimensions carry the most meaning (Matryoshka
 * representation learning). Keep a prefix, scale it back to length 1, and cosine similarity still works: 256
 * dimensions take a sixth of the space of 1,536 and lose a little recall.
 *
 * The prefix of a unit vector is shorter than 1, by a different amount for each vector, so it's scaled back to
 * length 1. Cosine distance (`<=>`) ignores length and wouldn't notice; inner product (`<#>`) and L2 (`<->`), which
 * are only right for unit vectors, would rank wrongly without it.
 */
export function truncateEmbedding(embedding: readonly number[], dimensions: number): number[] {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > embedding.length) {
    throw new RangeError(`can't keep ${dimensions} of ${embedding.length} dimensions`);
  }
  const prefix = embedding.slice(0, dimensions);
  const norm = Math.hypot(...prefix);
  if (norm === 0) throw new RangeError("the prefix is all zeros");
  return prefix.map((value) => value / norm);
}
