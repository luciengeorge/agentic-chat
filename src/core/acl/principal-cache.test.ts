// @vitest-environment node
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DirectoryPrincipal, DirectorySnapshot } from "#learn/directory/sync";
import type { Tx } from "@/db/tenant";

import { applyDirectory } from "#learn/directory/sync";
import { candidateDocuments, canRead, viewerPrincipals } from "#learn/retrieve/acl";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { cachedPrincipals, createPrincipalCache, directoryVersion } from "./principal-cache";

const LEO = "a0000000-0000-4000-8000-000000000001";
const FINANCE = "a0000000-0000-4000-8000-000000000002";
const AP = "a0000000-0000-4000-8000-000000000003";

const person = (id: string, kind: "user" | "group", name: string): DirectoryPrincipal => ({
  id,
  kind,
  name,
  displayName: name,
  email: null,
  enabled: true,
});
const PRINCIPALS = [
  person(LEO, "user", "leo.martin"),
  person(FINANCE, "group", "/Finance"),
  person(AP, "group", "/Finance/AP"),
];
const withLeoInAp: DirectorySnapshot = {
  principals: PRINCIPALS,
  edges: [
    { groupId: FINANCE, memberId: AP },
    { groupId: AP, memberId: LEO },
  ],
};
const withoutLeo: DirectorySnapshot = { principals: PRINCIPALS, edges: [{ groupId: FINANCE, memberId: AP }] };

describe.skipIf(!postgresAvailable)("the principal cache", () => {
  let t: TestDatabase;
  let tenant: string;
  let invoice: string;

  const inTenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenantOn(t.appDb, tenant, fn);
  const sync = (snapshot: DirectorySnapshot) => inTenant((tx) => applyDirectory(tx, tenant, snapshot, new Date()));

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: tenant }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
    await sync(withLeoInAp);
    [{ id: invoice }] = await t.sql`
      INSERT INTO documents (tenant_id, source, external_id, title, path, mime_type, version, source_version,
        content_hash, status, acl_version)
      VALUES (${tenant}, 'workspace', 'inv', 'Invoice', '/Finance/AP/Invoice.pdf', 'application/pdf', 1, 'v1', 'x',
        'ready', 1)
      RETURNING id`;
    await t.sql`
      INSERT INTO document_acl (tenant_id, document_id, principal_id, effect, acl_version)
      VALUES (${tenant}, ${invoice}, ${AP}, 'allow', 1)`;
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("takes a group removal into account on the first request after the sync", async () => {
    await sync(withLeoInAp);
    const cache = createPrincipalCache();
    const request = () =>
      inTenant(async (tx) => {
        const { principalIds } = await viewerPrincipals(tx, LEO, cache);
        return {
          principalIds: [...principalIds].sort(),
          candidates: await candidateDocuments(tx, principalIds),
          allowed: await canRead(tx, LEO, invoice),
        };
      });

    expect(await request()).toEqual({ principalIds: [LEO, FINANCE, AP].sort(), candidates: [invoice], allowed: true });
    expect(await request()).toMatchObject({ candidates: [invoice] });

    await sync(withoutLeo);
    expect(await request()).toEqual({ principalIds: [LEO], candidates: [], allowed: false });
  });

  it("reads the closure once per directory version, and a sync that changes nothing keeps the entry", async () => {
    await sync(withLeoInAp);
    const cache = createPrincipalCache();
    let loads = 0;
    const load = async (tx: Tx, userId: string) => {
      loads += 1;
      const rows = await tx.execute<{ id: string }>(
        sql`SELECT ${userId}::uuid AS id UNION ALL SELECT group_id FROM group_closure WHERE member_id = ${userId}`,
      );
      return rows.map((row) => row.id);
    };
    const principals = () => inTenant((tx) => cachedPrincipals(tx, LEO, cache, load));

    const first = await principals();
    await principals();
    expect(loads).toBe(1);

    const before = await inTenant(directoryVersion);
    await sync(withLeoInAp);
    expect(await inTenant(directoryVersion)).toEqual(before);
    await principals();
    expect(loads).toBe(1);

    await sync(withoutLeo);
    expect((await inTenant(directoryVersion)).version).toBe(before.version + 1);
    expect(await principals()).toEqual([LEO]);
    expect(first).toHaveLength(3);
    expect(loads).toBe(2);
  });

  it("can only over-fetch when stale: readable() still refuses the document", async () => {
    await sync(withLeoInAp);
    const cache = createPrincipalCache();
    await inTenant((tx) => viewerPrincipals(tx, LEO, cache));
    // A membership removed without a sync: nothing bumps the version, so the cached set is now stale.
    await t.sql`DELETE FROM group_closure WHERE member_id = ${LEO}`;
    await t.sql`DELETE FROM group_members WHERE member_id = ${LEO}`;

    const seen = await inTenant(async (tx) => {
      const { principalIds } = await viewerPrincipals(tx, LEO, cache);
      return {
        principalIds,
        candidates: await candidateDocuments(tx, principalIds),
        allowed: await canRead(tx, LEO, invoice),
      };
    });
    expect(seen.principalIds).toContain(AP);
    expect(seen.candidates).toEqual([invoice]);
    expect(seen.allowed).toBe(false);
  });

  it("keys entries by tenant: outside withTenant nothing is cached", async () => {
    const cache = createPrincipalCache();
    let loads = 0;
    const load = async () => {
      loads += 1;
      return [LEO];
    };
    await t.appDb.transaction((tx) => cachedPrincipals(tx, LEO, cache, load));
    await t.appDb.transaction((tx) => cachedPrincipals(tx, LEO, cache, load));
    expect(loads).toBe(2);
  });
});
