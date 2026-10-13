/**
 * `pnpm db:embed [tenant slug...]`: embeds every chunk with no embedding from the current model, for each tenant
 * (every one by default). Ingest embeds as it goes; this catches up chunks written before it did, or re-embeds
 * them all after the embedding model changes. It prints the tokens the provider counted and what they cost.
 */
import { embedderFromEnv } from "@/lib/retrieval.server";

import { embedPendingChunks } from "./embeddings";
import { closeDb, systemDb } from "./pool";
import { organization } from "./schema";
import { withTenant } from "./tenant";

/** text-embedding-3-small's list price, in US dollars per million tokens. */
const USD_PER_MILLION_TOKENS = 0.02;

const slugs = process.argv.slice(2);
// Listing tenants crosses them, so it reads as the owner; the chunks are read and written as the app role.
const tenants = await systemDb().select({ id: organization.id, slug: organization.slug }).from(organization);
const unknown = slugs.filter((slug) => !tenants.some((tenant) => tenant.slug === slug));
if (unknown.length) throw new Error(`no tenant ${unknown.join(", ")}`);

let billed = 0;
const embedder = embedderFromEnv(process.env, { onUsage: (tokens) => (billed += tokens) });
console.log(`embedder: ${embedder.version}`);
for (const tenant of slugs.length ? tenants.filter((tenant) => slugs.includes(tenant.slug)) : tenants) {
  const started = Date.now();
  const result = await embedPendingChunks(withTenant, embedder, { tenantId: tenant.id });
  console.log(
    `${tenant.slug}: ${result.chunks} chunks in ${result.batches} batches, ${result.tokens} tokens by our count, ` +
      `${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
}
console.log(`provider-counted tokens: ${billed}, about $${((billed / 1e6) * USD_PER_MILLION_TOKENS).toFixed(4)}`);
await closeDb(process.env.DATABASE_ADMIN_URL!);
await closeDb(process.env.DATABASE_URL!);
