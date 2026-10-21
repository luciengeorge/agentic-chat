---
title: Vendored dependencies and images
type: graded
slots:
  local/weights: weights.ts
  local/vendor: vendor.ts
---

# Vendored dependencies and images

👨‍💼 Steps 1 and 2 run on a machine with no way out. But `pnpm install` downloads packages, `docker compose up` pulls images, and the reranker's weights come from Hugging Face. On the air-gapped machine none of that works, so it all has to be packed beforehand, carried in, and checked when it lands. A bundle that's missing one file, or holds one corrupted, is found out on the day, where you can't fetch it again.

## Terms

- **Vendoring** is keeping a copy of everything you depend on, instead of fetching it when you need it.
- An **image** is a packaged container: a program and everything it needs. `docker save` writes one to a file, and `docker load` reads it back.
- A **Compose profile** is a label that keeps a service from starting until you ask for it (`--profile observability`).
- **sha256** is a fingerprint of a file's bytes: change one bit and it changes completely. A **revision** is one commit of a model's repository, which names one set of files for good.

## What's already written

`pnpm vendor` (`scripts/vendor.ts`) packs the bundle: `pnpm fetch` into a store of its own, `docker save` of each image `composeImages` picks, the weights, LM Studio's model folders, and a `MANIFEST.json` with the commands to run offline. `pnpm local:weights` fetches the reranker with `fetchWeights`, and `--check` runs `verifyWeights`, written in `weights.ts`: size first, since it's free, then the hash.

## Do this

🐨 In `playground/weights.ts`, write `fetchWeights`: download what's missing or wrong, from the pinned revision, so that a bad file never sits where the reranker loads it. Then in `playground/vendor.ts`, write `composeImages`: the images the air-gapped app runs, each once.

## A worked example

`pnpm vendor --dry-run` measures the bundle without writing it. What an air-gapped Kestrel needs:

| Part                                                                |        Size |
| ------------------------------------------------------------------- | ----------: |
| pnpm store (every package in the lockfile, this machine's binaries) |     1.96 GB |
| `paradedb/paradedb:0.26.1-pg18`, once                               |     1.49 GB |
| bge-reranker-base, five files                                       |     0.30 GB |
| nomic-embed-text-v1.5 (LM Studio)                                   |     0.08 GB |
| **Total**                                                           | **3.83 GB** |

Plus a chat model, not downloaded yet: about 5 GB for Qwen3 8B. Three Compose services run the paradedb image (the database, and the egress check's two), and it's saved once. The observability stack (3.48 GB) and docling (7.26 GB) belong to sections 19 and 03 and stay out unless you ask for `--images all`.

Run the tests with `pnpm ex test 21.3`. They serve a small model from a stand-in Hugging Face, so nothing is downloaded.
