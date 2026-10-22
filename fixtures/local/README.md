# Running air-gapped (section 21)

This folder holds what section 21 measures: dated reports in `reports/`, and the probe that tries to leave the
`airgap` network (`egress-probe.sh`). The code is in `src/core/local/`, imported as `#learn/local/*`.

"Air-gapped" means the machine has no route to the internet. Every model has to run on it, and every package,
image and weight file has to be brought in beforehand.

## The switch

`MODEL_PROVIDER=local` puts every model on this machine:

| Part | Hosted (the default) | Local |
|---|---|---|
| Chat, query rewrites, agents | OpenAI `gpt-6-luna` | LM Studio's chat model (`LOCAL_CHAT_MODEL`) |
| Embeddings | OpenAI `text-embedding-3-small`, 1,536 dimensions | LM Studio's `text-embedding-nomic-embed-text-v1.5`, 768 |
| Reranker | Cohere `rerank-v4.0-fast` | `Xenova/bge-reranker-base` (int8 ONNX) on transformers.js, in-process |

With it set, no OpenAI or Cohere client is built, even when their keys are in `.env.local`. Leave it unset and the
app runs exactly as before. Tests always use the fakes.

LM Studio is a desktop app that runs models and serves them on `http://127.0.0.1:1234/v1` in OpenAI's format.
`LMSTUDIO_BASE_URL`, `LOCAL_CHAT_MODEL`, `LOCAL_EMBEDDING_MODEL`, `LOCAL_RERANKER_MODEL` and `LOCAL_WEIGHTS_DIR`
change the defaults (`src/core/local/config.ts`).

## A chat model

The answer eval on local models ran on 22 Oct 2026 with Qwen3 8B (`reports/2026-10-22-full-local.md`): no leaks, 21 of 40
answers cite a labelled document (gpt-6-luna: 40 of 40), one abstain case answered, 56 minutes. To run it, download a model
that fits a 32 GB machine with other work on it. For example, Qwen3 8B at 4 bits is about 5 GB on disk and 6 to 7 GB
in memory with a 16k context:

```bash
lms get qwen/qwen3-8b
lms load qwen/qwen3-8b -c 16384
```

A 4B model (about 2.5 GB) leaves more room, though it answers worse. gpt-oss-20b (12 GB) fit too, but it pushed
this machine into swap. If you pick another model, set `LOCAL_CHAT_MODEL` to its identifier from `lms ps`.

## Running it

```bash
pnpm local:weights                 # the reranker's weights, 296 MB, into vendor/models (checked by sha256)
lms server start                   # LM Studio's server, if it's off
lms load text-embedding-nomic-embed-text-v1.5
pnpm local:db                      # ac_local: a copy of the dev database, re-embedded locally (about 10 min)
pnpm local:eval --retrieval-only --no-rewrite   # retrieval only; needs no chat model
pnpm local:eval                    # rewrites and answers too; needs the chat model loaded
pnpm local:bench                   # where the time goes, and tokens per second when a chat model is loaded
pnpm local:egress-check            # the airgap network refuses everything; the local path makes no outbound call
pnpm vendor --dry-run              # what an offline machine needs, and how big it is
```

`pnpm local:eval` checks LM Studio and the weights before it starts, and runs the eval under the egress monitor
(`scripts/local-guard.ts`), which refuses and counts any connection that leaves the machine.

## Why a second database

The `chunks` table has one embedding per chunk, as `vector(1536)`. A local model's vectors live in a different space,
so they can't sit next to OpenAI's and be compared with them. `pnpm local:db` copies the dev database to
`ac_local` and re-embeds it there, so `pnpm dev` keeps its OpenAI vectors. nomic's 768 dimensions are padded with
zeros to fill the column. Padding changes no cosine similarity, and the version
`text-embedding-nomic-embed-text-v1.5@768` keeps the vector search from comparing a query with a chunk of another
model.
