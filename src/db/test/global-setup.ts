import type { TestProject } from "vitest/node";

import postgres from "postgres";

declare module "vitest" {
  export interface ProvidedContext {
    // null when Postgres is unreachable: the database suites skip.
    postgres: { adminUrl: string; prefix: string } | null;
  }
}

// Each run gets its own prefix, and every test database starts with it, so teardown drops exactly
// what this run made.
export default async function setup(project: TestProject) {
  const adminUrl = process.env.DATABASE_URL ?? "postgres://ac:ac@localhost:5432/ac";
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

  project.provide("postgres", { adminUrl, prefix });

  return async () => {
    const rows = await sql<
      { datname: string }[]
    >`SELECT datname FROM pg_database WHERE starts_with(datname, ${prefix})`;
    for (const { datname } of rows) await sql.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    await sql.end();
  };
}
