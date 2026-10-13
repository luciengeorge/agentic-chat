import type { Embedder } from "./embed";

/** Lowercased words: letters and digits, split on anything else. */
export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

// FNV-1a, 32 bits: stable across runs and processes, unlike anything seeded.
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A deterministic stand-in for a real embedding model, for tests and for running without an API key. Each word
 * adds ±1 to a dimension picked by its hash (feature hashing), then the vector is scaled to length 1. Texts that
 * share words land close together, so search over it behaves sensibly, though it knows nothing of meaning.
 */
export function hashingEmbedder(dimensions: number): Embedder {
  return {
    version: `fake-hashing-v1@${dimensions}`,
    dimensions,
    async embed(values) {
      return values.map((text) => {
        const vector = Array.from<number>({ length: dimensions }).fill(0);
        // A small constant, so an empty text still has a direction (cosine distance to a zero vector is NaN).
        vector[0] = 0.01;
        for (const word of words(text)) {
          const hash = fnv1a(word);
          vector[hash % dimensions] += hash & 0x80000000 ? -1 : 1;
        }
        const norm = Math.hypot(...vector);
        return vector.map((value) => value / norm);
      });
    },
  };
}
