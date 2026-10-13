import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { inject } from "vitest";

import { APP_ROLE } from "./app-role";
import { createDb, type Db } from "./create";
import { migrateDatabase } from "./migrate";
import { closeDb, dbFor } from "./pool";

export interface TestDatabase {
  /** The owner's URL, which bypasses RLS. */
  url: string;
  sql: postgres.Sql;
  db: Db;
  /** The app role's URL, which RLS binds. */
  appUrl: string;
  /** The process-wide pool for `appUrl` (what `appDb()` returns with DATABASE_URL set to it). */
  appDb: Db;
  drop: () => Promise<void>;
}

export const postgresAvailable = inject("postgres") !== null;

/** A database of its own on the test server, dropped by `drop()` or, failing that, at the end of the run. */
export async function createTestDatabase({ migrated = true } = {}): Promise<TestDatabase> {
  const config = inject("postgres");
  if (!config) throw new Error("Postgres is unreachable; guard the suite with postgresAvailable");

  const name = `${config.prefix}_${randomUUID().slice(0, 8)}`;
  const admin = postgres(config.adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${name}"`);

  const url = new URL(config.adminUrl);
  url.pathname = `/${name}`;
  if (migrated) await migrateDatabase(url.toString());

  const appUrl = new URL(url);
  appUrl.username = APP_ROLE;
  appUrl.password = encodeURIComponent(config.appPassword);

  const db = createDb(url.toString());
  return {
    url: url.toString(),
    sql: db.$client,
    db,
    appUrl: appUrl.toString(),
    get appDb() {
      return dbFor(appUrl.toString());
    },
    drop: async () => {
      await closeDb(appUrl.toString());
      await db.$client.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}
