---
title: Batch embedding
type: graded
slots:
  embed/embed: embed.ts
---

# Batch embedding: the solution

`batches` refuses a size that isn't a whole number of at least 1, then steps through the list `size` at a time and slices each run. The last slice stops at the end of the list, so it's shorter when the count doesn't divide evenly, and an empty list gives no runs.

`embed` loops over those batches and awaits one `embedMany` per batch, with the model, the batch, `dimensions` and `maxParallelCalls`. It reports `usage.tokens`, checks every vector's length against `dimensions`, and pushes them in order.

## Why it works

- **Position is the only label.** Nothing inside a vector says which text it came from. `embedMany` returns `embeddings[i]` for `values[i]`, and awaiting the batches one after another appends them in input order, so vector i always lands on chunk i. Run the batches at once and push each as it finishes, and the order is the network's.
- **Nothing is left over.** Slicing up to `i + size` and letting the last slice run short keeps the remainder. Stopping at full runs would leave the last 178 of 434 chunks with no vector and no error.
- **The limits can't be hit.** 256 chunks of at most 512 tokens can't pass 131,072 tokens, under the 300,000 cap, and 256 is far under 2,048 inputs. Bigger batches would save a few round trips and risk a refused request; smaller ones would cost more round trips for nothing.
- **A wrong vector fails before it's stored.** A model that returns another length (another model, a missing `dimensions`) is stopped here, with the version in the message, before anything is written next to the wrong chunk.

## The worked example

434 chunks, 68,459 tokens: two calls of 256 and 178, about $0.0014. The filing: 5,274 chunks, 2,104,091 tokens, 21 calls (the last of 154), $0.042, and no batch over 112,920 tokens. The recorded vectors come back exactly, one per chunk, in order.

Embedding is cheap next to the chat model; what costs is doing it again. `embedPendingChunks` (in `src/db/embeddings.ts`) embeds only chunks with no vector from the current model, one batch per transaction, so a retry after a failure pays only for what's left.
