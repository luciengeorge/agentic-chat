/**
 * `pnpm local:db [--fresh]`: makes `ac_local`, a copy of the dev database in the same ParadeDB, and re-embeds its
 * chunks with LM Studio's embedding model. The copy is `pg_dump | pg_restore` run inside the paradedb container,
 * so nothing crosses to the host. Then every chunk without an embedding of the local version is embedded, a batch
 * per transaction, as `pnpm db:embed` does. Rerun it to finish an interrupted embed; `--fresh` drops the copy first.
 *
 * Needs the stack up (`pnpm ex up`) and LM Studio serving the embedding model (`lms load
 * text-embedding-nomic-embed-text-v1.5`).
 */
import { execFileSync } from "node:child_process";

import { localConfig } from "#learn/local/config";
import { embedPendingChunks } from "@/db/embeddings";
import { closeDb, dbFor } from "@/db/pool";
import { withTenantOn } from "@/db/tenant";
import { embedderFromEnv } from "@/lib/retrieval.server";

import { localDatabaseUrls } from "./local-common";

const env = { ...process.env, MODEL_PROVIDER: "local" };
const urls = localDatabaseUrls(env);
const fresh = process.argv.includes("--fresh");
const user = new URL(urls.sourceAdmin).username;
const compose = (...args: string[]) =>
  execFileSync("docker", ["compose", "exec", "-T", "paradedb", ...args], { encoding: "utf8" }).trim();

const exists =
  compose("psql", "-U", user, "-d", urls.source, "-Atc", `SELECT 1 FROM pg_database WHERE datname = '${urls.name}'`) ===
  "1";
if (exists && fresh) {
  compose("dropdb", "-U", user, "--force", urls.name);
  console.log(`dropped ${urls.name}`);
}
if (!exists || fresh) {
  const started = Date.now();
  compose("createdb", "-U", user, "-T", "template0", urls.name);
  compose("sh", "-c", `pg_dump -U ${user} -Fc ${urls.source} | pg_restore -U ${user} -d ${urls.name} --no-owner`);
  console.log(`copied ${urls.source} to ${urls.name} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

const admin = dbFor(urls.admin);
const app = dbFor(urls.app);
try {
  const embedder = embedderFromEnv(env, { purpose: "document" });
  console.log(`embedder: ${embedder.version} (${localConfig(env).baseURL})`);
  const tenants = await admin.$client<{ id: string; slug: string }[]>`SELECT id, slug FROM organization ORDER BY slug`;
  let total = 0;
  const started = performance.now();
  for (const tenant of tenants) {
    const t0 = performance.now();
    const result = await embedPendingChunks((tenantId, fn) => withTenantOn(app, tenantId, fn), embedder, {
      tenantId: tenant.id,
      batchSize: 64,
    });
    total += result.chunks;
    const seconds = (performance.now() - t0) / 1000;
    console.log(
      `${tenant.slug}: ${result.chunks} chunks, ${result.tokens} tokens in ${seconds.toFixed(1)} s` +
        (result.chunks ? ` (${(result.tokens / seconds).toFixed(0)} tokens/s)` : ""),
    );
  }
  const [counts] = await admin.$client<{ local: number; other: number }[]>`
    SELECT count(*) FILTER (WHERE embedding_model_version = ${embedder.version})::int AS local,
           count(*) FILTER (WHERE embedding_model_version IS DISTINCT FROM ${embedder.version})::int AS other
    FROM chunks`;
  console.log(
    `embedded ${total} chunks in ${((performance.now() - started) / 1000).toFixed(1)} s; ` +
      `${counts.local} chunks of ${embedder.version}, ${counts.other} of anything else`,
  );
} finally {
  await closeDb(urls.admin);
  await closeDb(urls.app);
}
