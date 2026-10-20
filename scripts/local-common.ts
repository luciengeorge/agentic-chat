/** Shared by the `local:*` scripts: the local database's URLs, derived from the dev ones. */

type Env = Record<string, string | undefined>;

/** The database the local measurements use: a copy of the dev database whose chunks carry local embeddings. The
 * chunks table holds one embedding per chunk, so the dev database keeps OpenAI's and this one gets the local
 * model's; nothing is overwritten that `pnpm dev` reads. */
export const LOCAL_DATABASE = "ac_local";

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

export function localDatabaseUrls(env: Env = process.env) {
  const app = env.DATABASE_URL;
  const admin = env.DATABASE_ADMIN_URL;
  if (!app || !admin) throw new Error("DATABASE_URL and DATABASE_ADMIN_URL must be set (.env.local)");
  const name = env.LOCAL_DATABASE_NAME || LOCAL_DATABASE;
  const source = new URL(admin).pathname.slice(1);
  if (name === source) throw new Error(`the local database can't be the dev database (${source})`);
  return { name, source, app: withDatabase(app, name), admin: withDatabase(admin, name), sourceAdmin: admin };
}
