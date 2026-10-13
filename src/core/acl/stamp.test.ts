// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Permission } from "#learn/connectors/graph";

import { documentAcl, documents, principals } from "@/db/schema";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { clearAcl, grantedIds, stampAcl } from "./stamp";

const EXEC = "11111111-1111-4111-8111-111111111111";
const TOM = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";

const grant = (kind: "user" | "group", id: string, role = "read", inherited = false): Permission => ({
  id: `${kind}:${id}`,
  roles: [role],
  grantedToV2: kind === "user" ? { user: { id } } : { group: { id, displayName: "/Kestrel/Exec" } },
  ...(inherited ? { inheritedFrom: { id: "parent", path: "/drive/root:/Exec" } } : {}),
});

describe("grantedIds", () => {
  it("takes own and inherited grants, read and write alike, each id once", () => {
    expect(
      grantedIds([grant("group", EXEC, "write", true), grant("user", TOM, "read"), grant("user", TOM, "write")]),
    ).toEqual([EXEC, TOM].sort());
  });

  it("grants nothing for a permission with no user or group", () => {
    expect(grantedIds([{ id: "link", roles: ["read"], grantedToV2: {} }])).toEqual([]);
  });
});

describe.skipIf(!postgresAvailable)("stampAcl", () => {
  let t: TestDatabase;
  let tenant: string;
  let harbour: string;
  let documentId: string;

  const inTenant = <T>(fn: Parameters<typeof withTenantOn<T>>[2]) => withTenantOn(t.appDb, tenant, fn);
  const acl = () =>
    inTenant((tx) =>
      tx
        .select({
          principalId: documentAcl.principalId,
          effect: documentAcl.effect,
          aclVersion: documentAcl.aclVersion,
        })
        .from(documentAcl),
    );
  const documentVersion = async () =>
    (await inTenant((tx) => tx.select({ v: documents.aclVersion }).from(documents)))[0].v;

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: tenant }, { id: harbour }] = await t.sql`
      INSERT INTO organization (name, slug, created_at)
      VALUES ('Kestrel Pay', 'kestrel', now()), ('Harbour Health', 'harbour', now())
      RETURNING id`;
    await inTenant((tx) =>
      tx.insert(principals).values([
        {
          id: EXEC,
          tenantId: tenant,
          kind: "group",
          externalId: EXEC,
          name: "/Kestrel/Exec",
          displayName: "/Kestrel/Exec",
          enabled: true,
          syncedAt: new Date(),
        },
        {
          id: TOM,
          tenantId: tenant,
          kind: "user",
          externalId: TOM,
          name: "tom.whitfield",
          displayName: "Tom",
          enabled: true,
          syncedAt: new Date(),
        },
      ]),
    );
  });

  beforeEach(async () => {
    await t.sql`DELETE FROM documents`;
    [{ id: documentId }] = await t.sql`
      INSERT INTO documents (tenant_id, source, external_id, title, path, mime_type, version, source_version,
        content_hash, status)
      VALUES (${tenant}, 'workspace', 'heron', 'Memo', '/Exec/Memo.pdf', 'application/pdf', 1, 'v1', 'x', 'pending')
      RETURNING id`;
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("writes allow rows and stamps one new acl_version on the rows and the document", async () => {
    const result = await inTenant((tx) => stampAcl(tx, documentId, [EXEC]));
    expect(result).toMatchObject({ changed: true, unknown: [] });
    expect(result.aclVersion).toBeGreaterThan(0);
    expect(await acl()).toEqual([{ principalId: EXEC, effect: "allow", aclVersion: result.aclVersion }]);
    expect(await documentVersion()).toBe(result.aclVersion);
  });

  it("draws nothing when the grants are the same", async () => {
    const first = await inTenant((tx) => stampAcl(tx, documentId, [EXEC]));
    const again = await inTenant((tx) => stampAcl(tx, documentId, [EXEC]));
    expect(again).toEqual({ aclVersion: first.aclVersion, changed: false, unknown: [] });
    const [{ last_value }] = await t.sql`SELECT last_value FROM acl_version_seq`;
    expect(Number(last_value)).toBe(first.aclVersion);
  });

  it("draws a later version for a change, and replaces the rows", async () => {
    const first = await inTenant((tx) => stampAcl(tx, documentId, [EXEC]));
    const second = await inTenant((tx) => stampAcl(tx, documentId, [EXEC, TOM]));
    expect(second.aclVersion).toBeGreaterThan(first.aclVersion);
    expect((await acl()).map((row) => [row.principalId, row.aclVersion]).sort()).toEqual(
      [
        [EXEC, second.aclVersion],
        [TOM, second.aclVersion],
      ].sort(),
    );
  });

  it("leaves out a grant to an unknown principal, so the ACL fails closed", async () => {
    const result = await inTenant((tx) => stampAcl(tx, documentId, [EXEC, STRANGER]));
    expect(result.unknown).toEqual([STRANGER]);
    expect((await acl()).map((row) => row.principalId)).toEqual([EXEC]);
  });

  it("stamps an empty ACL for a document nobody may read, and clears one", async () => {
    const empty = await inTenant((tx) => stampAcl(tx, documentId, []));
    expect(empty.changed).toBe(true);
    expect(await acl()).toEqual([]);

    await inTenant((tx) => stampAcl(tx, documentId, [TOM]));
    await inTenant((tx) => clearAcl(tx, documentId));
    expect(await acl()).toEqual([]);
    expect(await documentVersion()).toBeGreaterThan(empty.aclVersion);
  });

  it("can't stamp another tenant's document", async () => {
    await expect(withTenantOn(t.appDb, harbour, (tx) => stampAcl(tx, documentId, [EXEC]))).rejects.toThrow(
      `document ${documentId} not found`,
    );
    expect(await t.sql`SELECT count(*)::int AS n FROM document_acl`).toEqual([{ n: 0 }]);
  });
});
