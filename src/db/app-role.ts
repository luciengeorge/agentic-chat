import postgres from "postgres";

/** The role the app connects as. The `app_role` migration grants it what the app needs. */
export const APP_ROLE = "ac_app";

/** `appUrl` with its user and password checked: it must connect as the app role, with a password. */
export function appCredentials(appUrl: string): { user: string; password: string } {
  const url = new URL(appUrl);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (user !== APP_ROLE) throw new Error(`DATABASE_URL must connect as ${APP_ROLE}, not "${user}"`);
  if (!password) throw new Error("DATABASE_URL must carry the app role's password");
  return { user, password };
}

/**
 * Lets the app role log in with the password in `appUrl`, creating the role if no migration has yet. A role
 * belongs to the whole server, so a migration can't know its password; this runs after the migrations.
 */
export async function enableAppLogin(adminUrl: string, appUrl: string): Promise<void> {
  const { password } = appCredentials(appUrl);
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;
    END $$`);
    const [{ quoted }] = await sql<{ quoted: string }[]>`SELECT quote_literal(${password}) AS quoted`;
    await sql.unsafe(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD ${quoted}`);
  } finally {
    await sql.end();
  }
}
