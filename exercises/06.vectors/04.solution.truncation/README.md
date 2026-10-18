---
title: Dimension truncation
type: graded
slots:
  vectors/truncate: truncate.ts
---

# Dimension truncation: the solution

`truncateEmbedding` refuses a size that isn't a whole number from 1 to the vector's length, slices the first `dimensions` numbers, takes their length with `Math.hypot`, refuses a zero length, and divides every number by it.

## Why it works

- **The prefix still means something.** Matryoshka training scored the model on its prefixes too, so the first 256 numbers are a coarse version of the whole meaning, not an arbitrary quarter of it.
- **Rescaling makes it a unit vector again.** A unit vector's prefix is shorter than 1, by a different amount for every text. Divided by its own length, each prefix is length 1, and inner product equals cosine similarity again. Without it, inner product (`<#>`) and Euclidean distance (`<->`) mix each chunk's leftover length into its score; cosine (`<=>`) happens to hide the mistake, since it divides by both lengths itself.
- **One divisor keeps the direction.** Every number is divided by the same length, so the vector shrinks or stretches without turning.
- **OpenAI can do this for you.** The API's `dimensions` parameter returns vectors already shortened and rescaled. Truncating stored vectors yourself is what you do when you already have the 1,536 and want to test a smaller index without paying to embed everything again.

## The worked example

The hotel question's first 256 numbers have length 0.4719 and come back at length 1. Rescaled, 256 dimensions keep 77.0% of the true top 10 over the recorded chunks (87.2% at 512, 93.9% at 1,024). Skipping the rescale costs 3 more points at 256 (73.7%) and reorders 32 of 46 questions' top 10.

Is it worth it? A sixth of the bytes for about a quarter of the true neighbours lost at 256 dimensions (a third, on the full corpus), and HNSW loses more on top. For Kestrel, no: the index fits in memory as it is. The next step shrinks it further and loses less, by keeping every dimension at lower precision.
