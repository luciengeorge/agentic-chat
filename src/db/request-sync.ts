import { enqueueSync } from "./outbox";
/**
 * `pnpm sync [full|delta] [tenant slug...]`: asks for a sync of each tenant (every one by default) through the
 * outbox. The dev server's relay starts the runs within a couple of seconds.
 */
import { closeDb, systemDb } from "./pool";
import { organization } from "./schema";
import { withTenant } from "./tenant";

const [mode = "full", ...slugs] = process.argv.slice(2);
if (mode !== "full" && mode !== "delta") throw new Error(`mode must be full or delta, not ${mode}`);

// Listing tenants crosses them, so it reads as the owner; each request is written as the app role, in its tenant.
const tenants = await systemDb().select({ id: organization.id, slug: organization.slug }).from(organization);
const chosen = slugs.length ? tenants.filter((tenant) => slugs.includes(tenant.slug)) : tenants;
const unknown = slugs.filter((slug) => !tenants.some((tenant) => tenant.slug === slug));
if (unknown.length) throw new Error(`no tenant ${unknown.join(", ")}`);

for (const tenant of chosen) {
  const id = await withTenant(tenant.id, (tx) => enqueueSync(tx, tenant.id, mode));
  console.log(`${tenant.slug}: ${id ? `${mode} sync queued (${id})` : `a ${mode} sync is already waiting`}`);
}
await closeDb(process.env.DATABASE_ADMIN_URL!);
await closeDb(process.env.DATABASE_URL!);
