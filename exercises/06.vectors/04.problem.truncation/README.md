---
title: Dimension truncation
type: graded
slots:
  vectors/truncate: truncate.ts
---

# Dimension truncation

👨‍💼 Kestrel's HNSW index is 44 MB for 5,637 vectors, and it grows with every document. Each vector is 1,536 numbers, but text-embedding-3 puts the most meaning in the first ones. Keep 256 and every vector is a sixth of the size. The question is what that costs in search, and the answer depends on doing the cut right.

## Terms

- **Truncation** keeps the first n numbers of a vector and drops the rest.
- **Matryoshka representation learning** is how OpenAI trained these models: the first numbers were made to work on their own, like the outer doll of a set.
- A vector's **length** (or norm) is the square root of the sum of its squares. **Normalising** divides every number by it, so the length becomes 1.
- The **inner product** (dot product) multiplies two vectors number by number and adds it up. For vectors of length 1 it equals the cosine similarity, and it's cheaper.

## Do this

🐨 In `playground/truncate.ts`, write `truncateEmbedding`: keep a prefix, and make it a unit vector again. No database this time; the tests rank the recorded vectors in plain TypeScript.

## A worked example

Rachel Obi's question, "What is the nightly limit for a hotel in London?", has length 1 at 1,536 numbers. Its first 256 have length 0.4719. Divide each by 0.4719 (multiply by 2.119) and the prefix is length 1 again.

The chunks' prefixes have lengths from 0.4390 to 0.5622. Rank them by inner product without rescaling and those lengths leak into the score: 32 of the 46 golden questions get a different set of ten (45 of 46 a different order).

Rescaled, over the 428 distinct recorded chunks, an exact search at 256 dimensions finds 77.0% of the true top 10 (the top 10 by the full vectors). At 512 it finds 87.2%, at 1,024 93.9%. A `vector(256)` is 1,032 bytes against 6,152 for `vector(1536)`. On the full corpus the bench measured 67.6%, 78.9% and 90.2%.

Run the tests with `pnpm ex test 06.4`.
