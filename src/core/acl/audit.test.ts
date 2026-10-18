// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DirectoryPrincipal, DirectorySnapshot } from "#learn/directory/sync";
import type { Tx } from "@/db/tenant";

import { applyDirectory } from "#learn/directory/sync";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { aclHistory, setSyncRun } from "./audit";
import { clearAcl, stampAcl } from "./stamp";

const TOM = "b0000000-0000-4000-8000-000000000001";
const EXEC = "b0000000-0000-4000-8000-000000000002";
const FINANCE = "b0000000-0000-4000-8000-000000000003";

const person = (id: string, kind: "user" | "group", name: string): DirectoryPrincipal => ({
  id,
  kind,
  name,
  displayName: name,
  email: null,
  enabled: true,
});
const PRINCIPALS = [
  person(TOM, "user", "tom.whitfield"),
  person(EXEC, "group", "/Exec"),
  person(FINANCE, "group", "/Finance"),
];
const snapshot = (edges: DirectorySnapshot["edges"]): DirectorySnapshot => ({ principals: PRINCIPALS, edges });

describe.skipIf(!postgresAvailable)("the ACL audit log", () => {
  let t: TestDatabase;
  let kestrel: string;
  let harbour: string;
  let memo: string;

  const inKestrel = <T>(fn: (tx: Tx) => Promise<T>) => withTenantOn(t.appDb, kestrel, fn);

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: kestrel }, { id: harbour }] = await t.sql`
      INSERT INTO organization (name, slug, created_at)
      VALUES ('Kestrel Pay', 'kestrel', now()), ('Harbour Health', 'harbour', now())
      RETURNING id`;
    await inKestrel((tx) => applyDirectory(tx, kestrel, snapshot([]), new Date()));
    [{ id: memo }] = await t.sql`
      INSERT INTO documents (tenant_id, source, external_id, title, path, mime_type, version, source_version,
        content_hash, status)
      VALUES (${kestrel}, 'workspace', 'heron', 'Memo', '/Exec/Memo.pdf', 'application/pdf', 1, 'v1', 'x', 'ready')
      RETURNING id`;
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("keeps a document's ACL history: each stamp and the clear, before and after, by sync run, oldest first", async () => {
    await inKestrel(async (tx) => {
      await setSyncRun(tx, "wrun_first");
      await stampAcl(tx, memo, [EXEC]);
    });
    await inKestrel((tx) => stampAcl(tx, memo, [EXEC]));
    await inKestrel(async (tx) => {
      await setSyncRun(tx, "wrun_second");
      await stampAcl(tx, memo, [EXEC, TOM]);
    });
    await inKestrel((tx) => clearAcl(tx, memo));

    const history = await inKestrel((tx) => aclHistory(tx, memo));
    expect(history.map(({ at: _, aclVersion: __, ...entry }) => entry)).toEqual([
      { action: "stamp", before: [], after: [EXEC], syncRunId: "wrun_first" },
      { action: "stamp", before: [EXEC], after: [EXEC, TOM].sort(), syncRunId: "wrun_second" },
      { action: "clear", before: [EXEC, TOM].sort(), after: [], syncRunId: null },
    ]);
    const versions = history.map((entry) => entry.aclVersion);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    const [{ acl_version }] = await t.sql`SELECT acl_version FROM documents WHERE id = ${memo}`;
    expect(versions.at(-1)).toBe(Number(acl_version));
  });

  it("writes a row for each direct membership added or removed", async () => {
    await inKestrel(async (tx) => {
      await setSyncRun(tx, "wrun_directory");
      await applyDirectory(tx, kestrel, snapshot([{ groupId: EXEC, memberId: TOM }]), new Date());
    });
    await inKestrel((tx) => applyDirectory(tx, kestrel, snapshot([{ groupId: FINANCE, memberId: TOM }]), new Date()));
    const rows = await t.sql`
      SELECT action, group_id, member_id, before, after, sync_run_id FROM acl_audit
      WHERE subject = 'membership' ORDER BY id`;
    expect(rows.map((row) => ({ ...row }))).toEqual([
      {
        action: "added",
        group_id: EXEC,
        member_id: TOM,
        before: { member: false },
        after: { member: true },
        sync_run_id: "wrun_directory",
      },
      {
        action: "added",
        group_id: FINANCE,
        member_id: TOM,
        before: { member: false },
        after: { member: true },
        sync_run_id: null,
      },
      {
        action: "removed",
        group_id: EXEC,
        member_id: TOM,
        before: { member: true },
        after: { member: false },
        sync_run_id: null,
      },
    ]);
  });

  it("is append-only for the app role", async () => {
    const update = await inKestrel((tx) => tx.execute(`UPDATE acl_audit SET action = 'stamp'` as never)).catch(
      (error: unknown) => error,
    );
    expect(update).toMatchObject({ cause: { code: "42501" } });
    const remove = await inKestrel((tx) => tx.execute(`DELETE FROM acl_audit` as never)).catch(
      (error: unknown) => error,
    );
    expect(remove).toMatchObject({ cause: { code: "42501" } });
    expect((await t.sql`SELECT count(*)::int AS n FROM acl_audit`)[0].n).toBeGreaterThan(0);
  });

  it("shows a tenant only its own history", async () => {
    expect(await withTenantOn(t.appDb, harbour, (tx) => aclHistory(tx, memo))).toEqual([]);
  });
});
