---
title: Changing a tokenizer without downtime
type: graded
slots:
  search/reindex: reindex.ts
---

# Changing a tokenizer without downtime: the solution

`beginTokenizerChange` refuses a `to` named like `from`, builds `chunks_bm25_next` concurrently with `[from, to]`, then calls `replaceBm25Index`: drop the old index concurrently, rename the new one to `chunks_bm25_idx`.

`compareFields` runs `lexicalSearch` on each field for each query, keeps the ids, and divides how many of `from`'s ids `to` also returned by `from`'s count (1 when both are empty, 0 when only `from` is).

## Why it works

- **pg_search serves from the newest index.** Once a concurrent build is valid, every query uses it. So the only safe new index is one where the old field answers exactly as before: same name, same tokenizer. The new tokenizer sits beside it under an alias and changes nothing until something asks for it.
- **There's always an index.** Build first, then drop, then rename. Without a BM25 index, `|||` doesn't fall back to a scan; it fails ("does not contain a `USING paradedb` index").
- **The cutover is a setting, and so is the rollback.** Retrieval reads `lexicalField`. Point it at `text_v2` and the app searches the new tokens; point it back while `text` is still in the index and you've undone it, with no rebuild.
- **The dual read is free.** Both fields live in one index, so comparing them costs two searches, on real questions, before anyone depends on the answer.
- **The finish comes later.** `finishTokenizerChange` builds an index with the new field alone, the same way, once nothing reads the old one.

## The worked example

"2026": 148 chunks on `text`, 144 on `text_v2`. "KPC-2026-0142": 150 against 8, every one holding the number. Over the eight identifier questions the new field keeps between half and nine tenths of today's top 10, and the right first chunk stays first for Leo's question. Those moved chunks are what you'd read before switching.

Embeddings have the same problem in another shape. `chunks.embedding_model_version` says which model made each vector, and search compares only vectors of one version. Changing the model without downtime would mean a second vector column with its own HNSW index (pgvector allows several), filled in the background, then the same switch and dual read. The app doesn't build that yet.
