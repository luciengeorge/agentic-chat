---
title: Air-gapped
---

# Air-gapped

Some of Kestrel's customers, and Kestrel's own regulator, ask the same question: can the assistant run with nothing leaving our network? That rules out OpenAI and Cohere, and any download on the day. Every model has to run on the machine, the network has to have no way out, and every package, image and weight file has to be brought in beforehand and checked.

## Terms

- **Air-gapped** means a machine, or a network, with no route to the internet. **Egress** is traffic that leaves.
- **LM Studio** is a desktop app that runs models on this machine and serves them in OpenAI's format on `http://127.0.0.1:1234/v1`, so the AI SDK talks to it as it would to OpenAI.
- A **cross-encoder** reads a question and one chunk together and gives one score. It's what a reranker is, and the one piece that has to run inside the app: bge-reranker-base, on **transformers.js** (Hugging Face's models in Node).
- **Vendoring** is keeping a copy of everything you depend on, instead of fetching it when you need it.

## The switch

`MODEL_PROVIDER=local` puts every model on the machine. Leave it unset and the app runs as before; tests always use the fakes.

| Part                         | Hosted (the default)                              | Local                                                  |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| Chat, query rewrites, agents | OpenAI `gpt-6-luna`                               | LM Studio's chat model (`LOCAL_CHAT_MODEL`)            |
| Embeddings                   | OpenAI `text-embedding-3-small`, 1,536 dimensions | LM Studio's `nomic-embed-text-v1.5`, 768, padded       |
| Reranker                     | Cohere `rerank-v4.0-fast`                         | `Xenova/bge-reranker-base` (int8) in the app's process |

With it set, no OpenAI or Cohere client is built, even with their keys in `.env.local`. Local vectors can't sit beside OpenAI's, so `pnpm local:db` copies the dev database to `ac_local` and re-embeds it there. A production build for local models is `pnpm build:local`; a plain `pnpm build` leaves the reranker's native engine out.

## The steps

1. **Local models, and the local reranker** (`local/rerank.ts`). Score each chunk with a sigmoid over its logit, and see why transformers.js's pipeline API scores every one 1.0.
2. **Egress blocked** (`local/egress.ts`). The network is the wall; write the monitor that refuses, and lists, every connection that would leave the app.
3. **Vendored dependencies and images** (`local/weights.ts`, `local/vendor.ts`). Fetch the weights so a bad file never lands, and pick the images the bundle needs.

## The numbers

Measured on 2026-10-20 over the golden set, with no query rewrites on either side. Recall@10 (the share of right pages in the top 10) is 1.000 for both. MRR (the mean of 1 over the rank of the first right chunk) is 0.944 hosted and 0.887 local. Every gate passes too (no leak, no other tenant's chunk, every abstention empty-handed: the ACLs are in the database, so the models can't change them). A local retrieval takes 3.2 s, nearly all of it the reranker on the CPU. The answer eval waits for a chat model: none is downloaded yet, and Qwen3 8B (about 5 GB) fits. The bundle for an offline machine is 3.83 GB, plus that chat model.

## What you need

Nothing, for the tests: they replay recordings and stand-ins. To run it for real: `pnpm local:weights` (the reranker, 296 MB), LM Studio's server with nomic loaded, and `pnpm local:db`. `fixtures/local/README.md` has the commands, and `fixtures/local/reports/` every measurement.

The lab, `/labs/airgap`, shows which models are local, and turns the egress monitor on inside the dev server: what it lets through and what it refuses.
