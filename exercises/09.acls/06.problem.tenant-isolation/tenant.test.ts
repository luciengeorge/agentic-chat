// @vitest-environment node
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

import type { Db } from "@/db/create";

import { withTenantOn } from "#learn/acl/tenant";
import { noRewriter } from "#learn/query/rewrite";
import { overlapReranker } from "#learn/rerank/rerank";
import { canRead, UnknownViewerError } from "#learn/retrieve/acl";
import { createRetrieve } from "#learn/retrieve/retrieve";
import { setupAclWorld, WORLD_EMBEDDER } from "@/core/acl/testing";
import { principals } from "@/db/schema";
import { postgresAvailable } from "@/db/testing";

const world = setupAclWorld({ chunks: true });

describe.skipIf(!postgresAvailable)("tenant isolation", () => {
  const COUNTS = sql`SELECT (SELECT count(*)::int FROM documents) AS documents,
    (SELECT count(*)::int FROM chunks) AS chunks, (SELECT count(*)::int FROM principals) AS principals`;
  type Counts = { documents: number; chunks: number; principals: number };
  const counts = (db: Db, tenantId: string) =>
    withTenantOn(db, tenantId, (tx) => tx.execute<Counts>(COUNTS).then(([row]) => row));
  /** Outside any tenant. Not chunks: pg_search refuses a query on its index when the tenant is NULL. */
  const untenanted = (db: Db) =>
    db
      .execute<{ documents: number; principals: number }>(
        sql`SELECT (SELECT count(*)::int FROM documents) AS documents,
          (SELECT count(*)::int FROM principals) AS principals`,
      )
      .then(([row]) => row);

  it("shows a tenant's transaction its own rows, and the app role nothing outside one", async () => {
    const { t, tenants } = world.get();
    expect(await counts(t.appDb, tenants.kestrel)).toEqual({ documents: 40, chunks: 375, principals: 42 });
    expect(await counts(t.appDb, tenants.harbour)).toEqual({ documents: 6, chunks: 59, principals: 10 });
    expect(
      await untenanted(t.appDb),
      "outside withTenant the policies match no tenant: no rows. Seeing a tenant's rows here means an earlier " +
        "transaction's setting stayed on this pooled connection",
    ).toEqual({
      documents: 0,
      principals: 0,
    });
    const chunks = await t.appDb.execute(sql`SELECT count(*) FROM chunks`).catch((caught: unknown) => caught);
    expect(chunks, "and the BM25 index refuses outright").toMatchObject({
      cause: { message: "pushdown expression should not evaluate to NULL" },
    });
  });

  it("runs the callback in the transaction that set the tenant", async () => {
    const { t, tenants } = world.get();
    const seen = await withTenantOn(t.appDb, tenants.harbour, async (tx) => {
      const [row] = await tx.execute<{ tenant: string }>(sql`SELECT current_setting('app.tenant_id', true) AS tenant`);
      return row.tenant;
    });
    expect(seen, "hand the callback the transaction, after setting app.tenant_id on it").toBe(tenants.harbour);
  });

  it("forgets the tenant when the transaction ends, even on the same pooled connection", async () => {
    const { t, tenants } = world.get();
    const client = postgres(t.appUrl, { max: 1, onnotice: () => {} });
    const single = drizzle({ client }) as unknown as Db;
    try {
      expect((await counts(single, tenants.kestrel)).documents).toBe(40);
      expect(
        (await untenanted(single)).documents,
        "the next query on this connection saw Kestrel's 40 documents: the setting outlived the transaction. " +
          "set_config's third argument is is_local: false (like a plain SET) keeps it for the connection's life, " +
          "true (like SET LOCAL) ends it with the transaction",
      ).toBe(0);
    } finally {
      await client.end();
    }
  });

  it("keeps nothing from a callback that throws, and lets the error out", async () => {
    const { t, tenants } = world.get();
    const error = await withTenantOn(t.appDb, tenants.kestrel, async (tx) => {
      await tx.insert(principals).values({
        tenantId: tenants.kestrel,
        kind: "user",
        externalId: "intruder",
        name: "intruder",
        displayName: "Intruder",
        enabled: true,
        syncedAt: new Date(),
      });
      throw new Error("the request failed halfway");
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "the request failed halfway" });
    expect(await t.sql`SELECT name FROM principals WHERE name = 'intruder'`, "run fn inside the transaction").toEqual(
      [],
    );
  });

  it("refuses a write into another tenant: RLS checks new rows too", async () => {
    const { t, tenants } = world.get();
    const error = await withTenantOn(t.appDb, tenants.kestrel, (tx) =>
      tx.insert(principals).values({
        tenantId: tenants.harbour,
        kind: "user",
        externalId: "intruder",
        name: "intruder",
        displayName: "Intruder",
        enabled: true,
        syncedAt: new Date(),
      }),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ cause: { code: "42501" } });
  });

  it("refuses a tenant id that isn't a uuid before it opens a transaction", async () => {
    let opened = 0;
    const counting = {
      transaction: async () => {
        opened += 1;
        throw new Error("opened a transaction");
      },
    } as unknown as Db;
    for (const id of ["", "kestrel", "' OR true --"]) {
      const error = await withTenantOn(counting, id, async () => "ran").catch((caught: unknown) => caught);
      expect(error, `${JSON.stringify(id)} is not a tenant id: throw`).toBeInstanceOf(Error);
    }
    expect(opened, "check the id first: a bad one never reaches the database").toBe(0);
  });

  it("is the only thing between tenants: the owner sees all 46 documents, and ac_app owns no table", async () => {
    const { t } = world.get();
    expect((await t.sql`SELECT count(*)::int AS n FROM documents`)[0].n).toBe(46);
    const [role] = await t.appDb.execute<{ user: string; rolsuper: boolean; rolbypassrls: boolean }>(sql`
      SELECT current_user AS user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(role).toEqual({ user: "ac_app", rolsuper: false, rolbypassrls: false });
    expect(
      await t.sql`
      SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relowner = 'ac_app'::regrole`,
    ).toEqual([]);
  });

  it("answers nina.osei from Harbour's 6 documents only, and Kestrel's memo doesn't exist from there", async () => {
    const w = world.get();
    const retrieve = createRetrieve({
      withTenant: (tenantId, fn) => withTenantOn(w.t.appDb, tenantId, fn),
      embedder: WORLD_EMBEDDER,
      reranker: overlapReranker(),
      rewriter: noRewriter,
    });
    const nina = { tenantId: w.tenants.harbour, userId: w.user("nina.osei", "harbour") };
    const retrieval = await retrieve(nina, "What is the hotel limit for a night in London?");
    expect(retrieval.chunks.length).toBeGreaterThan(0);
    const harbourDocuments = new Set(
      (await w.t.sql`SELECT id FROM documents WHERE tenant_id = ${w.tenants.harbour}`).map((row) => row.id),
    );
    expect(retrieval.chunks.every((chunk) => harbourDocuments.has(chunk.documentId))).toBe(true);

    const memo = await w.documentId("/Exec/Project Heron Board Memo.pdf");
    const fromHarbour = await withTenantOn(w.t.appDb, w.tenants.harbour, async (tx) => ({
      rows: await tx.execute(sql`SELECT id FROM documents WHERE id = ${memo}`),
      daniel: await canRead(tx, w.user("daniel.reyes"), memo),
    }));
    expect(fromHarbour).toEqual({ rows: [], daniel: false });
    const leoInHarbour = await retrieve({ tenantId: w.tenants.harbour, userId: w.user("leo.martin") }, "hotel").catch(
      (caught: unknown) => caught,
    );
    expect(leoInHarbour, "leo.martin isn't a principal in Harbour").toBeInstanceOf(UnknownViewerError);
  });
});
