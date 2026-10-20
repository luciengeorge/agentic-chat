/**
 * `pnpm local:weights`: fetches the local reranker's weights (bge-reranker-base, ONNX, int8) into the vendored
 * weights folder (`vendor/models`, or LOCAL_WEIGHTS_DIR), from a pinned revision, each file checked by size and
 * sha256. Files already there and right are kept, so it's safe to rerun. `--check` downloads nothing: it says
 * what's there, and exits 1 when anything is missing or wrong.
 */
import { localConfig } from "#learn/local/config";
import { fetchWeights, RERANKER_WEIGHTS, verifyWeights } from "#learn/local/weights";

const config = localConfig();
const check = process.argv.includes("--check");
const manifest = RERANKER_WEIGHTS;
if (config.rerankerModel !== manifest.repo) {
  throw new Error(`LOCAL_RERANKER_MODEL is ${config.rerankerModel}; this script vendors ${manifest.repo} only`);
}
const total = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
console.log(
  `${manifest.repo}@${manifest.revision.slice(0, 12)} into ${config.weightsDir} (${(total / 1e6).toFixed(0)} MB)`,
);

if (check) {
  const result = await verifyWeights(manifest, config.weightsDir);
  for (const entry of result) console.log(`${entry.status.padEnd(10)} ${entry.path}`);
  process.exitCode = result.every((entry) => entry.status === "ok") ? 0 : 1;
} else {
  const { downloaded, kept } = await fetchWeights(manifest, config.weightsDir, { log: (line) => console.log(line) });
  console.log(`downloaded ${downloaded.length}, kept ${kept.length}; all ${manifest.files.length} verified`);
}
