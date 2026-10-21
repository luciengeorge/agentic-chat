// A hosted build (`pnpm build`) bundles this module where transformers.js would be (src/core/local/build.ts), so
// the local reranker's first load fails with this message instead of a missing native module.
throw new Error(
  "this build has no local models: `pnpm build` leaves transformers.js and onnxruntime-node out. " +
    "Build with `pnpm build:local` to run MODEL_PROVIDER=local from .output",
);
