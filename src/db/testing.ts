import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { inject } from "vitest";

import { createDb, type Db } from "./create";
import { migrateDatabase } from "./migrate";

export interface TestDatabase {
  url: string;
  sql: postgres.Sql;
  db: Db;
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

  const db = createDb(url.toString());
  return {
    url: url.toString(),
    sql: db.$client,
    db,
    drop: async () => {
      await db.$client.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}
