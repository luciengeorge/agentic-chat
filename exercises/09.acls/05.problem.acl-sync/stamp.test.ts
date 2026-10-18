// @vitest-environment node
import { describe, expect, it } from "vitest";

import { aclHistory, setSyncRun } from "#learn/acl/audit";
import { stampAcl } from "#learn/acl/stamp";
import { canRead } from "#learn/retrieve/acl";
import { setupAclWorld } from "@/core/acl/testing";
import { postgresAvailable } from "@/db/testing";

const world = setupAclWorld({ drive: false });
const HERON = "/Exec/Project Heron Board Memo.pdf";

describe.skipIf(!postgresAvailable)("the ACL sync and its audit log", () => {
  const audit = () =>
    world.get().t.sql<{ action: string; document_id: string; acl_version: string; sync_run_id: string | null }[]>`
      SELECT action, document_id, acl_version, sync_run_id FROM acl_audit WHERE subject = 'document' ORDER BY id`;
  const mark = async () => Number((await world.get().t.sql`SELECT last_value FROM acl_version_seq`)[0].last_value);
  const names = async (ids: string[]) => {
    const rows = await world.get().t.sql<{ id: string; name: string }[]>`SELECT id, name FROM principals`;
    const name = new Map(rows.map((row) => [row.id, row.name]));
    return ids.map((id) => name.get(id)).sort();
  };

  it("stamps each of Kestrel's 40 documents once in a full sync: a new acl_version and an audit row each, naming the run", async () => {
    const w = world.get();
    const report = await w.syncDrive("kestrel", (tx) => setSyncRun(tx, "wrun_full_sync"));
    expect(report.files).toBe(40);
    expect(report.aclChanged, "every new document's ACL is a change").toBe(40);
    expect(report.unknownPrincipals).toEqual([]);

    const rows = await audit();
    expect(rows, "one audit row per change: call recordDocumentAcl").toHaveLength(40);
    expect(rows.every((row) => row.action === "stamp" && row.sync_run_id === "wrun_full_sync")).toBe(true);
    const versions = rows.map((row) => Number(row.acl_version));
    expect(new Set(versions).size, "each change draws its own version from acl_version_seq").toBe(40);
    expect(Math.min(...versions)).toBe(1);
    expect(Math.max(...versions)).toBe(await mark());

    const stamped = await w.t.sql<{ document: number; rows: number; effects: string[] }[]>`
      SELECT d.acl_version AS document, count(*)::int AS rows, array_agg(DISTINCT a.effect) AS effects
      FROM documents d JOIN document_acl a ON a.document_id = d.id AND a.acl_version = d.acl_version
      WHERE d.tenant_id = ${w.tenants.kestrel} GROUP BY d.id`;
    expect(stamped, "every row of a stamp carries the document's new acl_version").toHaveLength(40);
    expect(new Set(stamped.flatMap((row) => row.effects))).toEqual(new Set(["allow"]));
  });

  it("writes the Heron memo's ACL as the drive shares it: one allow, for /Kestrel/Exec", async () => {
    const w = world.get();
    const memo = await w.documentId(HERON);
    const history = await w.inTenant("kestrel", (tx) => aclHistory(tx, memo));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ action: "stamp", before: [], syncRunId: "wrun_full_sync" });
    expect(await names(history[0].after)).toEqual(["/Kestrel/Exec"]);
  });

  it("draws nothing on a sync that changes nothing: no version, no audit row", async () => {
    const w = world.get();
    const [before, rows] = [await mark(), (await audit()).length];
    const report = await w.syncDrive("kestrel", (tx) => setSyncRun(tx, "wrun_quiet"));
    expect(report.aclChanged, "compare the grants with the rows held, and stop when they're the same").toBe(0);
    expect(await mark(), "a version drawn for no change makes every ACL look newer than it is").toBe(before);
    expect((await audit()).length).toBe(rows);
  });

  it("moves the memo to a version above every other when it's shared with leo.martin, and records before and after", async () => {
    const w = world.get();
    const memo = await w.documentId(HERON);
    const leo = w.user("leo.martin");
    // Ingestion would have marked them ready by now.
    await w.t.sql`UPDATE documents SET status = 'ready'`;
    expect(await w.inTenant("kestrel", (tx) => canRead(tx, leo, memo))).toBe(false);
    const highest = await mark();
    expect(highest).toBe(40);

    await w.control("PUT", `/sites/kestrel/items/${w.itemId(HERON)}/sharing`, {
      inherit: true,
      grants: [{ principal_type: "user", principal_id: leo, principal_name: "leo.martin", role: "read" }],
    });
    try {
      const report = await w.syncDrive("kestrel", (tx) => setSyncRun(tx, "wrun_shared"));
      expect(report.aclChanged).toBe(1);
      const last = (await w.inTenant("kestrel", (tx) => aclHistory(tx, memo))).at(-1)!;
      expect(last).toMatchObject({ action: "stamp", syncRunId: "wrun_shared" });
      expect(last.aclVersion, "the newest change has the highest version, across every document").toBe(highest + 1);
      expect(await names(last.before)).toEqual(["/Kestrel/Exec"]);
      expect(await names(last.after)).toEqual(["/Kestrel/Exec", "leo.martin"]);
      expect(await w.inTenant("kestrel", (tx) => canRead(tx, leo, memo)), "Postgres decides from the new rows").toBe(
        true,
      );
    } finally {
      await w.control("PUT", `/sites/kestrel/items/${w.itemId(HERON)}/sharing`, { inherit: true, grants: [] });
      await w.syncDrive("kestrel");
    }
  });

  it("leaves out a grant to someone the directory hasn't synced yet, and says so: the ACL fails closed", async () => {
    const w = world.get();
    const memo = await w.documentId(HERON);
    const stranger = "c0000000-0000-4000-8000-00000000beef";
    const result = await w
      .inTenant("kestrel", (tx) => stampAcl(tx, memo, [w.group("/Kestrel/Exec"), stranger]))
      .catch((error: unknown) => error);
    expect(
      result,
      "a row for an id with no principal breaks the foreign key: leave unknown ids out",
    ).not.toBeInstanceOf(Error);
    expect((result as { unknown: string[] }).unknown, "report the ids with no principal").toEqual([stranger]);
    const rows = await w.t.sql`SELECT principal_id FROM document_acl WHERE document_id = ${memo}`;
    expect(
      rows.map((row) => row.principal_id),
      "no row for a principal that doesn't exist: there's nobody it could let in, and nothing to join",
    ).toEqual([w.group("/Kestrel/Exec")]);
  });

  it("gives a document nobody may read a version too, with a clear in the audit", async () => {
    const w = world.get();
    const [{ id }] = await w.t.sql<{ id: string }[]>`
      INSERT INTO documents (tenant_id, source, external_id, title, path, mime_type, version, source_version,
        content_hash, status)
      VALUES (${w.tenants.kestrel}, 'test', 'locked', 'Locked.md', '/Exec/Locked.md', 'text/markdown', 1, '1', 'x',
        'pending')
      RETURNING id`;
    const result = await w.inTenant("kestrel", (tx) => stampAcl(tx, id, []));
    expect(result.changed, "acl_version 0 means never stamped: the first stamp is a change, even to nobody").toBe(true);
    expect(result.aclVersion).toBe(await mark());
    const history = await w.inTenant("kestrel", (tx) => aclHistory(tx, id));
    expect(history.map((entry) => entry.action)).toEqual(["clear"]);
  });
});
