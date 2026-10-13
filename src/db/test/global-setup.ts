import type { TestProject } from "vitest/node";

import postgres from "postgres";

import { APP_ROLE, enableAppLogin } from "../app-role";

declare module "vitest" {
  export interface ProvidedContext {
    // null when Postgres is unreachable: the database suites skip.
    postgres: { adminUrl: string; appPassword: string; prefix: string } | null;
  }
}

const DEFAULT_ADMIN_URL = "postgres://ac:ac@localhost:5432/ac";
/** The dev password from .env.example. The role belongs to the whole server, so tests keep the one dev uses. */
const DEFAULT_APP_PASSWORD = "ac_app";

/** The app role's password: DATABASE_URL's when it connects as the app role, else the dev one. */
function appPassword(): string {
  const url = process.env.DATABASE_URL ? URL.parse(process.env.DATABASE_URL) : null;
  if (url && decodeURIComponent(url.username) === APP_ROLE && url.password) return decodeURIComponent(url.password);
  return DEFAULT_APP_PASSWORD;
}

// Each run gets its own prefix, and every test database starts with it, so teardown drops exactly
// what this run made.
export default async function setup(project: TestProject) {
  const adminUrl = process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL || DEFAULT_ADMIN_URL;
  const prefix = `ac_test_${Date.now().toString(36)}_${process.pid}`;
  const sql = postgres(adminUrl, { max: 1, connect_timeout: 3, onnotice: () => {} });

  try {
    await sql`SELECT 1`;
  } catch (error) {
    await sql.end({ timeout: 0 });
    const where = new URL(adminUrl).host;
    if (process.env.AC_REQUIRE_POSTGRES === "1") {
      throw new Error(`Postgres is unreachable at ${where} and AC_REQUIRE_POSTGRES=1`, { cause: error });
    }
    console.warn(
      `Postgres is unreachable at ${where}: skipping the database tests (AC_REQUIRE_POSTGRES=1 fails instead)`,
    );
    project.provide("postgres", null);
    return;
  }

  // Once per run, before any test migrates: concurrent ALTER ROLEs would collide.
  const password = appPassword();
  const appUrl = new URL(adminUrl);
  appUrl.username = APP_ROLE;
  appUrl.password = encodeURIComponent(password);
  await enableAppLogin(adminUrl, appUrl.toString());

  project.provide("postgres", { adminUrl, appPassword: password, prefix });

  return async () => {
    const rows = await sql<
      { datname: string }[]
    >`SELECT datname FROM pg_database WHERE starts_with(datname, ${prefix})`;
    for (const { datname } of rows) await sql.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    await sql.end();
  };
}
