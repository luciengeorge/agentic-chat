// @vitest-environment node

import { indexing, search } from "@paradedb/drizzle-paradedb";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres";
import { desc, l2Distance } from "drizzle-orm";
import { integer, pgTable, text, vector } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, postgresAvailable, type TestDatabase } from "./testing";

// A tiny table in the throwaway database, declared and indexed through Drizzle like the real ones
// will be in sections 06 and 07.
const probe = pgTable(
  "search_probe",
  {
    id: integer("id").primaryKey(),
    body: text("body").notNull(),
    embedding: vector("embedding", { dimensions: 3 }).notNull(),
  },
  (t) => [indexing.paradedbIndex("search_probe_bm25").on(t.id, t.body)],
);

describe.skipIf(!postgresAvailable)("pg_search and pgvector through Drizzle", () => {
  let t: TestDatabase;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    t = await createTestDatabase();
    const ddl = await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson({ probe }));
    for (const statement of ddl) await t.sql.unsafe(statement);
    db = drizzle({ client: t.sql });
    await db.insert(probe).values([
      { id: 1, body: "Contract KPC-2025-0099 renews in 2026", embedding: [0, 1, 0] },
      { id: 2, body: "Contract KPC-2026-0142: supplier terms for Kestrel Payouts", embedding: [1, 0, 0] },
      { id: 3, body: "The office lunch menu", embedding: [0, 0, 1] },
    ]);
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("ranks the matching row first with a BM25 query", async () => {
    const rows = await db
      .select({ id: probe.id, score: search.score(probe.id) })
      .from(probe)
      .where(search.matchAll(probe.body, "KPC-2026-0142"))
      .orderBy(desc(search.score(probe.id)));

    expect(rows.map((row) => row.id)).toEqual([2]);
    expect(rows[0].score).toBeGreaterThan(0);
  });

  it("finds the nearest neighbour with pgvector", async () => {
    const rows = await db
      .select({ id: probe.id })
      .from(probe)
      .orderBy(l2Distance(probe.embedding, [0.9, 0.1, 0]))
      .limit(1);

    expect(rows).toEqual([{ id: 2 }]);
  });
});
