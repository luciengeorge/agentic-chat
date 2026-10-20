---
title: Vendored dependencies and images
type: graded
slots:
  local/weights: weights.ts
  local/vendor: vendor.ts
---

# Vendored dependencies and images: the solution

`fetchWeights` asks `verifyWeights` what's on disk, and keeps every file that's "ok". For each other file it makes the folder, requests `https://huggingface.co/<repo>/resolve/<revision>/<path>`, and throws if the response isn't ok. It streams the body to `<target>.partial`, then checks that file's size and sha256 against the manifest. On a mismatch it deletes the `.partial` and throws, naming the file and both fingerprints. Only a match is renamed to the target. `composeImages` keeps the services with no profiles, with `airgap` among their profiles, or every one with `all`, and returns their images through a `Set`, so each comes once, in order.

## Why it works

- **The target only ever holds a checked file.** A rename within one folder is atomic: whoever opens the target sees the old file or the new one, never half. A download that dies leaves a `.partial`, which the reranker never loads, and the next run fetches the file again.
- **The hash, not the size.** A file can be the right length and still wrong: one bit flipped by a bad disk, or a different build of the model. The test flips one bit of 5,200; the size can't see it, the sha256 can. Size is checked first because it costs nothing.
- **Pinned all the way down.** The weights come from a commit (`280bcc27...`), never `main`; the images have exact tags; the packages come from the lockfile. Each pin is what makes "the same bytes I tested" checkable on the other side.
- **Safe to run again.** What's right is kept, so a rerun after a failure fetches only what's missing or wrong, and `pnpm local:weights --check` is the same check offline.
- **Profiles say what runs.** The app's own services have no profile; `airgap` is the egress check. Three of those services share the paradedb image, so the `Set` saves 1.49 GB instead of 4.47 GB.

## The worked example

The dry run: pnpm store 1.96 GB, paradedb 1.49 GB, the reranker 0.30 GB (296,400,660 bytes in five files, each with its sha256), nomic 0.08 GB: **3.83 GB**, plus about 5 GB for a chat model. With `--images all` the bundle adds otel-lgtm (3.48 GB) and docling (7.26 GB).

## On the offline machine

`MANIFEST.json` lists the steps: install Node 22, pnpm 10, Docker and LM Studio from their installers; `pnpm install --offline --frozen-lockfile --store-dir <bundle>/pnpm-store`; `docker load` each image; copy the models into `~/.lmstudio/models` and `vendor/models`; `pnpm local:weights --check`. Then `pnpm build:local` and `MODEL_PROVIDER=local pnpm start`: the local build keeps transformers.js and onnxruntime-node (450 MB of `.output`, against 119 MB hosted), which a plain `pnpm build` leaves out.

Two limits worth knowing. The store holds this machine's native binaries only (darwin-arm64): for a Linux server, set pnpm's `supportedArchitectures` before vendoring. And LM Studio, as installed, may check for updates; on an air-gapped machine, turn that off.
