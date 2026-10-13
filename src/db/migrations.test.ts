// @vitest-environment node

import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrateDatabase, MIGRATIONS_FOLDER } from "./migrate";
import * as schema from "./schema";
import { catalog } from "./test/catalog";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "./testing";

// Objects only the custom migrations create, because the Drizzle schema can't declare them.
const CUSTOM_ONLY = [
  "index CREATE INDEX group_closure_member_idx ON public.group_closure USING btree (member_id, group_id) INCLUDE (tenant_id)",
  "index CREATE UNIQUE INDEX member_user_id_key ON public.member USING btree (user_id)",
];

const migrationDirs = readdirSync(MIGRATIONS_FOLDER, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe.skipIf(!postgresAvailable)("migrations", () => {
  let migrated: TestDatabase;

  beforeAll(async () => {
    migrated = await createTestDatabase({ migrated: false });
    await migrateDatabase(migrated.url);
  });

  afterAll(async () => {
    await migrated?.drop();
  });

  it("apply cleanly, and a second run applies nothing", async () => {
    await migrateDatabase(migrated.url);
    const rows = await migrated.sql`SELECT name FROM drizzle.__drizzle_migrations ORDER BY id`;
    expect(rows.map((row) => row.name)).toEqual(migrationDirs);
  });

  it("create pg_search and vector", async () => {
    const rows = await migrated.sql`SELECT extname FROM pg_extension WHERE extname IN ('pg_search', 'vector')`;
    expect(rows.map((row) => row.extname).sort()).toEqual(["pg_search", "vector"]);
  });

  it("index the organization slug once", async () => {
    const rows = await migrated.sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'organization' AND indexdef LIKE '%(slug)'`;
    expect(rows.map((row) => row.indexname)).toEqual(["organization_slug_key"]);
  });

  it("leave nothing in the schema for drizzle-kit generate to add", async () => {
    const latest = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, migrationDirs.at(-1)!, "snapshot.json"), "utf8"));
    expect(await generateMigration(latest, await generateDrizzleJson(schema))).toEqual([]);
  });

  it("build the same database as the schema, apart from the custom indexes", async () => {
    const fromSchema = await createTestDatabase({ migrated: false });
    try {
      await fromSchema.sql`CREATE EXTENSION IF NOT EXISTS vector`;
      await fromSchema.sql`CREATE EXTENSION IF NOT EXISTS pg_search`;
      const statements = await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson(schema));
      for (const statement of statements) await fromSchema.sql.unsafe(statement);
      // The app_role migration forces RLS on every table the schema enables it on: Drizzle can't declare FORCE.
      const enabled = await fromSchema.sql`
        SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity`;
      for (const { relname } of enabled)
        await fromSchema.sql.unsafe(`ALTER TABLE "${relname}" FORCE ROW LEVEL SECURITY`);

      const want = new Set(await catalog(fromSchema.sql));
      const got = new Set(await catalog(migrated.sql));
      expect({
        onlyInMigrations: [...got].filter((line) => !want.has(line)),
        onlyInSchema: [...want].filter((line) => !got.has(line)),
      }).toEqual({ onlyInMigrations: CUSTOM_ONLY, onlyInSchema: [] });
    } finally {
      await fromSchema.drop();
    }
  });
});
