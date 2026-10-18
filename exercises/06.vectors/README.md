---
title: Embeddings and vectors
---

# Embeddings and vectors

Ask Kestrel's assistant "What is the nightly limit for a hotel in London?" and it finds the hotels clause of the expenses policy, though the clause never says "nightly limit for a hotel in London" in those words. It finds it by meaning. Every chunk, and every question, is turned into a list of numbers that stands for what the text is about, and search looks for the chunks whose numbers sit closest to the question's. This section builds that half of search: making the numbers, storing them in Postgres, finding the closest ones fast, and making them smaller.

## Terms

- An **embedding** (or **vector**) is that list of numbers. Ours come from OpenAI's `text-embedding-3-small`: 1,536 numbers per text. Each position is a **dimension**.
- **Cosine similarity** says how close two vectors point: 1 is the same direction, 0 unrelated. **Cosine distance** is 1 minus it, so smaller is closer. The **nearest neighbours** of a question are the chunks at the smallest distance.
- **pgvector** is the Postgres extension that stores vectors (types `vector`, `halfvec`, `bit`) and compares them (`<=>` is cosine distance).
- **Exact search** compares the question with every chunk. **Approximate nearest-neighbour search (ANN)** looks at only some of them, through an index, and may miss a few.
- **HNSW** (hierarchical navigable small world) is the index pgvector uses for ANN: a graph where each vector links to its near neighbours, which a search walks towards the question.
- **Recall@k** is the share of the true k nearest that a search found in its first k. 9 of the true top 10 is a recall@10 of 0.9.
- **Quantisation** stores each number in fewer bytes: `halfvec` keeps 2 bytes a number instead of 4, `bit` keeps one bit.

## The data

The tests use a recording made from the dev database (`fixtures/vectors/recording/`, by `pnpm vectors:record`): all 434 chunks outside the 3,000-page filing, from both tenants, each with its real embedding, and the 46 golden questions with theirs. Nothing in this section calls OpenAI. The numbers for the whole corpus, filing included (5,637 distinct vectors), come from `pnpm vectors:bench`, in `fixtures/vectors/reports/2026-10-14.md`.

## The steps

1. **Batch embedding** (`embed.ts`). Embed thousands of chunks in a few calls, each vector back on its own chunk.
2. **HNSW and filtered search** (`hnsw.ts`, `vector.ts`). The index's knobs, and the app's vector search, which must still find chunks when a filter throws most neighbours away.
3. **Exact vs approximate** (`recall.ts`). Measure what HNSW misses, against an exact scan.
4. **Dimension truncation** (`truncate.ts`). Keep the first 256 numbers of 1,536, and pay for it in recall.
5. **halfvec, bit and rescoring, plus sizing** (`quantize.ts`, `sizing.ts`). Make the index 16 times smaller and win back most of the recall.

The lab, `/labs/vectors`, runs every variant on your code over the dev corpus and plots recall against time.
