import { fileURLToPath } from "node:url";

/**
 * Section 21's build switch. The local reranker runs transformers.js on onnxruntime-node, a native module of about
 * 220 MB: too big for a Vercel function, and no use to a hosted deploy, which reranks with Cohere. So a hosted build
 * (`pnpm build`, the default) leaves it out: transformers.js is swapped for a module that says what to do instead,
 * and the bundle neither holds nor traces it. A local build (`pnpm build:local`, `LOCAL_BUILD=1`) keeps
 * transformers.js out of the bundle, loads it from node_modules, and traces it with onnxruntime's native binary
 * into `.output`, so `MODEL_PROVIDER=local pnpm start` reranks on this machine.
 */
export function localBuild(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.LOCAL_BUILD?.trim() ?? "";
  if (value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error(`LOCAL_BUILD must be 1 or unset; got "${value}"`);
}

/** The packages only local models use. */
export const LOCAL_ONLY_PACKAGES = ["@huggingface/transformers"];

/** What a local build copies into `.output` whole (the trailing `*`): onnxruntime-node loads its binary by a path it
 * builds at run time, which tracing alone can't follow. */
export const LOCAL_TRACE_DEPS = ["@huggingface/transformers*", "onnxruntime-node*", "onnxruntime-common*"];

/** What a hosted build bundles where transformers.js would be. */
export const NO_LOCAL_MODELS = fileURLToPath(new URL("./no-local-models.ts", import.meta.url));
