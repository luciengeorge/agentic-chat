/**
 * Migrating a database that isn't the dev one (section 22): the cloud ParadeDB, through `pnpm db:migrate:remote`.
 * It reads both URLs from the shell, never from `.env.local`, checks them and the server before it changes
 * anything, applies the migrations as the owner, gives the app role its login, then signs in as the app role to
 * check that row-level security binds it.
 */
import postgres from "postgres";

import { APP_ROLE, appCredentials, enableAppLogin } from "@/db/app-role";
import { migrateDatabase } from "@/db/migrate";

type Env = Record<string, string | undefined>;

const EXTENSIONS = ["vector", "pg_search"] as const;
export const MIN_APP_PASSWORD = 16;

/** Where a URL points, without its password: safe to print. */
export function describeUrl(url: string): string {
  const parsed = new URL(url);
  return `${decodeURIComponent(parsed.username)}@${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
}

/** Everything wrong with the two URLs, before anything connects. Empty when they're fine. */
export function targetProblems(env: Env, { minPassword = MIN_APP_PASSWORD } = {}): string[] {
  const adminUrl = env.DATABASE_ADMIN_URL?.trim();
  const appUrl = env.DATABASE_URL?.trim();
  const problems: string[] = [];
  if (!adminUrl) problems.push("DATABASE_ADMIN_URL must be set: the owner runs the migrations");
  if (!appUrl) problems.push(`DATABASE_URL must be set: ${APP_ROLE}'s password comes from it`);
  if (!adminUrl || !appUrl) return problems;

  let admin: URL;
  let app: URL;
  try {
    admin = new URL(adminUrl);
    app = new URL(appUrl);
  } catch {
    return ["DATABASE_URL and DATABASE_ADMIN_URL must be postgres:// URLs"];
  }
  try {
    const { password } = appCredentials(appUrl);
    if (password.length < minPassword) {
      problems.push(
        `${APP_ROLE}'s password is ${password.length} characters; use ${minPassword} or more (openssl rand -hex 16)`,
      );
    }
  } catch (error) {
    problems.push((error as Error).message);
  }
  if (decodeURIComponent(admin.username) === APP_ROLE)
    problems.push(`DATABASE_ADMIN_URL must be the owner, not ${APP_ROLE}`);
  const where = (url: URL) => `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  if (where(admin) !== where(app)) {
    problems.push(`the two URLs point at different databases: ${where(admin)} and ${where(app)}`);
  }
  return problems;
}

export interface RemoteReport {
  target: string;
  server: string;
  extensions: Record<string, string>;
  applied: number;
  total: number;
  appRole: { user: string; bypassesRls: boolean; documentsWithoutTenant: number };
}

async function appliedCount(sql: postgres.Sql): Promise<number> {
  const [{ exists }] = await sql<
    { exists: boolean }[]
  >`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists`;
  if (!exists) return 0;
  const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  return count;
}

/**
 * Checks the server can hold this app (pg_search and vector available, an owner that bypasses row-level security,
 * as the relay and the cron routes need), migrates, enables the app role, and checks it.
 */
export async function migrateRemote(adminUrl: string, appUrl: string, log: (line: string) => void = console.log) {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  let before: number;
  let server: string;
  try {
    [{ server }] = await admin<{ server: string }[]>`SELECT current_setting('server_version') AS server`;
    const available = await admin<{ name: string; default_version: string }[]>`
      SELECT name, default_version FROM pg_available_extensions WHERE name IN ${admin(EXTENSIONS)}`;
    const missing = EXTENSIONS.filter((name) => !available.some((row) => row.name === name));
    if (missing.length) {
      throw new Error(
        `this server has no ${missing.join(" or ")}: run the paradedb/paradedb image (Fly, Railway) or ParadeDB Cloud`,
      );
    }
    const [role] = await admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    if (!role.rolsuper && !role.rolbypassrls) {
      throw new Error(
        "DATABASE_ADMIN_URL's role is bound by row-level security: the relay and the cron routes cross tenants, " +
          "so it must be a superuser or have BYPASSRLS",
      );
    }
    before = await appliedCount(admin);
  } finally {
    await admin.end();
  }
  log(`target ${describeUrl(adminUrl)}, Postgres ${server}; ${before} migrations already applied`);

  await migrateDatabase(adminUrl);
  await enableAppLogin(adminUrl, appUrl);

  const owner = postgres(adminUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  const app = postgres(appUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const total = await appliedCount(owner);
    const rows = await owner<{ extname: string; extversion: string }[]>`
      SELECT extname, extversion FROM pg_extension WHERE extname IN ${owner(EXTENSIONS)} ORDER BY extname`;
    const extensions = Object.fromEntries(rows.map((row) => [row.extname, row.extversion]));
    const [me] = await app<{ user: string; bypass: boolean }[]>`
      SELECT current_user AS user, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`;
    const [{ visible }] = await app<{ visible: number }[]>`SELECT count(*)::int AS visible FROM documents`;
    if (me.user !== APP_ROLE || me.bypass)
      throw new Error(`the app URL signs in as ${me.user}, bypassing RLS: ${me.bypass}`);
    if (visible !== 0) throw new Error(`${APP_ROLE} sees ${visible} documents with no tenant set: RLS doesn't bind it`);
    const report: RemoteReport = {
      target: describeUrl(adminUrl),
      server,
      extensions,
      applied: total - before,
      total,
      appRole: { user: me.user, bypassesRls: me.bypass, documentsWithoutTenant: visible },
    };
    log(
      `applied ${report.applied} (${total} in all); ${Object.entries(extensions)
        .map(([n, v]) => `${n} ${v}`)
        .join(", ")}`,
    );
    log(`${APP_ROLE} signs in, doesn't bypass row-level security, and sees 0 documents without a tenant`);
    return report;
  } finally {
    await Promise.all([owner.end(), app.end()]);
  }
}

export const MIN_ACCOUNT_PASSWORD = 12;

/** The dev database, whose passwords the README and the tests rely on: never rotated. */
function isDevDatabase(url: string): boolean {
  const parsed = new URL(url);
  return (
    ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) &&
    (parsed.port || "5432") === "5432" &&
    parsed.pathname === "/ac"
  );
}

/**
 * Gives every email-and-password account one new password, and ends every session. world.yaml's password is public,
 * so a deploy that copied the dev data changes it before anyone can reach it. better-auth's own hash, so its sign-in
 * accepts the new one.
 */
export async function rotatePasswords(
  adminUrl: string,
  password: string,
): Promise<{ accounts: number; sessions: number }> {
  if (password.length < MIN_ACCOUNT_PASSWORD) {
    throw new Error(`the new password is ${password.length} characters; use ${MIN_ACCOUNT_PASSWORD} or more`);
  }
  if (isDevDatabase(adminUrl)) throw new Error("that's the dev database: its people keep world.yaml's password");
  const { hashPassword } = await import("better-auth/crypto");
  const hash = await hashPassword(password);
  const sql = postgres(adminUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    return await sql.begin(async (tx) => {
      const accounts =
        await tx`UPDATE account SET password = ${hash}, updated_at = now() WHERE provider_id = 'credential'`;
      const sessions = await tx`DELETE FROM session`;
      return { accounts: accounts.count, sessions: sessions.count };
    });
  } finally {
    await sql.end();
  }
}
