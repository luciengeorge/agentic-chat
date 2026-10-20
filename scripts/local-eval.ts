/**
 * `pnpm local:eval [eval args]`: the golden eval (`scripts/eval.ts`) with every model local, against `ac_local`
 * (`pnpm local:db`), under the egress monitor, writing to fixtures/local/reports/. Arguments go through to the
 * eval: `--retrieval-only`, `--no-rewrite`, `--only a,b`.
 *
 * Before it starts it checks what it needs, so a missing piece is one clear line: LM Studio answering on its port
 * with the chat model (unless `--retrieval-only --no-rewrite`) and the embedding model loaded, and the reranker's
 * weights on disk. It never loads a model: `lms load` is yours to run, since a 20B model takes 12 GB.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { localConfig } from "#learn/local/config";
import { RERANKER_WEIGHTS, verifyWeights } from "#learn/local/weights";

import { localDatabaseUrls } from "./local-common";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const config = localConfig();
const urls = localDatabaseUrls();
const needsChat = !(args.includes("--retrieval-only") && args.includes("--no-rewrite"));

const loaded = await fetch(`${config.baseURL}/models`)
  .then(async (response) => ((await response.json()) as { data: { id: string }[] }).data.map((model) => model.id))
  .catch((error: Error) => {
    throw new Error(`LM Studio isn't answering on ${config.baseURL} (${error.message}); run \`lms server start\``);
  });
for (const model of [config.embeddingModel, ...(needsChat ? [config.chatModel] : [])]) {
  if (!loaded.includes(model)) throw new Error(`LM Studio doesn't list ${model}; run \`lms load ${model}\``);
}
const weights = await verifyWeights(RERANKER_WEIGHTS, config.weightsDir);
if (weights.some((file) => file.status !== "ok")) {
  throw new Error(`the reranker's weights aren't all there; run \`pnpm local:weights\``);
}

const out = args.includes("--out") ? [] : ["--out", "fixtures/local/reports"];
const result = spawnSync(
  "pnpm",
  ["exec", "tsx", "--import", "./scripts/local-guard.ts", "scripts/eval.ts", ...args, ...out],
  {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, MODEL_PROVIDER: "local", DATABASE_URL: urls.app, DATABASE_ADMIN_URL: urls.admin },
  },
);
process.exitCode = result.status ?? 1;
