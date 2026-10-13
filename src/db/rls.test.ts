// @vitest-environment node

import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { documents, principals } from "./schema";
import * as app from "./schema/app";
import { withTenantOn } from "./tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "./testing";

const tenantTables = Object.values(app as Record<string, unknown>)
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableName(table))
  .sort();

const principal = (tenantId: string, name: string) => ({
  tenantId,
  kind: "user",
  externalId: name,
  name,
  displayName: name,
  enabled: true,
  syncedAt: new Date(),
});

describe.skipIf(!postgresAvailable)("row-level security on the app role", () => {
  let t: TestDatabase;
  let kestrel: string;
  let harbour: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: kestrel }, { id: harbour }] = await t.sql`
      INSERT INTO organization (name, slug, created_at)
      VALUES ('Kestrel Pay', 'kestrel', now()), ('Harbour Health', 'harbour', now())
      RETURNING id`;
    await t.db.insert(principals).values([principal(kestrel, "leo.martin"), principal(harbour, "nina.osei")]);
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("connects as ac_app, which owns nothing and has no BYPASSRLS", async () => {
    const [role] = await t.appDb.execute<{ user: string; rolsuper: boolean; rolbypassrls: boolean }>(sql`
      SELECT current_user AS user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(role).toEqual({ user: "ac_app", rolsuper: false, rolbypassrls: false });
    const owned = await t.sql`
      SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relowner = 'ac_app'::regrole`;
    expect(owned).toEqual([]);
  });

  it("forces RLS on every tenant table", async () => {
    const rows = await t.sql`
      SELECT relname FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity`;
    expect(rows.map((row) => row.relname).sort()).toEqual(tenantTables);
  });

  it("sees no tenant rows outside withTenant", async () => {
    expect(await t.appDb.select().from(principals)).toEqual([]);
    expect(await t.appDb.select().from(documents)).toEqual([]);
  });

  it("sees only the tenant's own rows inside withTenant", async () => {
    const names = (tenantId: string) =>
      withTenantOn(t.appDb, tenantId, async (tx) => (await tx.select().from(principals)).map((row) => row.name));
    expect(await names(kestrel)).toEqual(["leo.martin"]);
    expect(await names(harbour)).toEqual(["nina.osei"]);
  });

  it("refuses a write into another tenant", async () => {
    const error = await withTenantOn(t.appDb, kestrel, (tx) =>
      tx.insert(principals).values(principal(harbour, "intruder")),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ cause: { code: "42501" } });
    expect(await t.sql`SELECT name FROM principals WHERE name = 'intruder'`).toEqual([]);
  });

  it("can't move a row into another tenant", async () => {
    const error = await withTenantOn(t.appDb, kestrel, (tx) =>
      tx
        .update(principals)
        .set({ tenantId: harbour })
        .where(sql`name = 'leo.martin'`),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ cause: { code: "42501" } });
  });

  it("forgets the tenant when the transaction ends", async () => {
    await withTenantOn(t.appDb, kestrel, async () => {});
    expect(await t.appDb.select().from(principals)).toEqual([]);
  });

  it("refuses a tenant id that isn't a uuid", async () => {
    await expect(withTenantOn(t.appDb, "", async () => {})).rejects.toThrow("not a tenant id");
  });

  it("reads and draws from acl_version_seq", async () => {
    const [drawn] = await t.appDb.execute<{ value: string }>(sql`SELECT nextval('acl_version_seq') AS value`);
    const [mark] = await t.appDb.execute<{ value: string }>(
      sql`SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS value FROM acl_version_seq`,
    );
    expect(Number(mark.value)).toBeGreaterThanOrEqual(Number(drawn.value));
  });

  it("can't create tables or change the schema", async () => {
    await expect(t.appDb.execute(sql`CREATE TABLE probe (id int)`)).rejects.toMatchObject({
      cause: { code: "42501" },
    });
    await expect(t.appDb.execute(sql`ALTER TABLE principals NO FORCE ROW LEVEL SECURITY`)).rejects.toMatchObject({
      cause: { code: "42501" },
    });
  });
});
