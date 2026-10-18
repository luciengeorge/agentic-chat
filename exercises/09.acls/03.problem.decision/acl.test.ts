// @vitest-environment node
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { canRead, readable } from "#learn/retrieve/acl";
import { setupAclWorld } from "@/core/acl/testing";
import { postgresAvailable } from "@/db/testing";

const world = setupAclWorld();

const HERON = "/Exec/Project Heron Board Memo.pdf";
const POLICY = "/HR/Policies/Travel and Expenses Policy v2.pdf";
const REGISTER = "/Legal/Contracts/Contract Register 2026-09-28.pdf";
const INVOICES = "/Finance/AP/AP Batch B-2026-117 Scanned Invoices.pdf";
const CHECKLIST = "/Finance/Month-End Close Checklist.md";

describe.skipIf(!postgresAvailable)("readable(), the one access decision", () => {
  const may = async (username: string, path: string) => {
    const w = world.get();
    const documentId = await w.documentId(path);
    return w.inTenant("kestrel", (tx) => canRead(tx, w.user(username), documentId));
  };

  it("lets daniel.reyes read the Heron memo and refuses leo.martin: its one grant is to /Kestrel/Exec", async () => {
    const w = world.get();
    const grants = await w.t.sql`
      SELECT p.name, a.effect FROM document_acl a JOIN principals p ON p.id = a.principal_id
      JOIN documents d ON d.id = a.document_id WHERE d.path = ${HERON}`;
    expect(grants.map((row) => ({ ...row }))).toEqual([{ name: "/Kestrel/Exec", effect: "allow" }]);
    expect(await may("daniel.reyes", HERON), "daniel is a direct member of /Kestrel/Exec").toBe(true);
    expect(await may("leo.martin", HERON), "leo holds no principal with a grant on the memo").toBe(false);
  });

  it("reaches a document through nested groups: leo reads the travel policy, shared with /Kestrel two levels up", async () => {
    expect(await may("leo.martin", POLICY), "join on group_closure, not just the user's own id").toBe(true);
  });

  it("counts what each person may read of Kestrel's 40 documents, as one expression over a column", async () => {
    const w = world.get();
    const count = (username: string) =>
      w.inTenant("kestrel", async (tx) => {
        const [row] = await tx.execute<{ total: number; readable: number }>(sql`
          SELECT count(*)::int AS total,
            count(*) FILTER (WHERE ${readable(w.user(username), sql`doc.id`)})::int AS readable
          FROM documents doc`);
        return row;
      });
    expect(await count("leo.martin")).toEqual({ total: 40, readable: 18 });
    expect((await count("daniel.reyes")).readable).toBe(25);
    expect((await count("sam.patel")).readable).toBe(15);
    expect((await count("ella.brooks")).readable).toBe(9);
  });

  it("gives a disabled user nothing, though the closure still lists his groups: peter.hall reads 0", async () => {
    const w = world.get();
    const [{ readable: n, groups }] = await w.inTenant("kestrel", (tx) =>
      tx.execute<{ readable: number; groups: number }>(sql`
        SELECT count(*) FILTER (WHERE ${readable(w.user("peter.hall"), sql`doc.id`)})::int AS readable,
          (SELECT count(*)::int FROM group_closure WHERE member_id = ${w.user("peter.hall")}) AS groups
        FROM documents doc`),
    );
    expect(groups).toBe(3);
    expect(n, "the user must be an enabled user principal").toBe(0);
  });

  it("doesn't count a grant to a disabled group: with /Kestrel/Finance disabled, leo keeps AP's invoices and loses the register", async () => {
    const w = world.get();
    expect(await may("leo.martin", REGISTER)).toBe(true);
    await w.t.sql`UPDATE principals SET enabled = false WHERE id = ${w.group("/Kestrel/Finance")}`;
    try {
      expect(await may("leo.martin", REGISTER), "the register is shared with Finance (and Legal): Finance is off").toBe(
        false,
      );
      expect(await may("leo.martin", INVOICES), "the invoices are shared with AP too, which is still on").toBe(true);
    } finally {
      await w.t.sql`UPDATE principals SET enabled = true WHERE id = ${w.group("/Kestrel/Finance")}`;
    }
  });

  it("lets a deny win over any allow, for the user or any group they hold", async () => {
    const w = world.get();
    const policy = await w.documentId(POLICY);
    await w.t.sql`
      INSERT INTO document_acl (tenant_id, document_id, principal_id, effect, acl_version)
      VALUES (${w.tenants.kestrel}, ${policy}, ${w.group("/Kestrel/Finance/AP")}, 'deny', 1)`;
    try {
      expect(await may("leo.martin", POLICY), "a deny on AP, a group leo holds, beats the allow on /Kestrel").toBe(
        false,
      );
      expect(await may("tom.whitfield", POLICY), "tom isn't in AP: the deny doesn't touch him").toBe(true);
    } finally {
      await w.t.sql`DELETE FROM document_acl WHERE document_id = ${policy} AND effect = 'deny'`;
    }
  });

  it("refuses a document that isn't ready, and anyone the tenant doesn't know", async () => {
    const w = world.get();
    await w.t.sql`UPDATE documents SET status = 'ingesting' WHERE path = ${CHECKLIST}`;
    try {
      expect(await may("leo.martin", CHECKLIST), "only a ready document can be read").toBe(false);
    } finally {
      await w.t.sql`UPDATE documents SET status = 'ready' WHERE path = ${CHECKLIST}`;
    }
    const policy = await w.documentId(POLICY);
    const nina = w.user("nina.osei", "harbour");
    expect(await w.inTenant("kestrel", (tx) => canRead(tx, nina, policy)), "nina.osei is Harbour's").toBe(false);
  });

  it("decides the same whatever the calling query names its own tables", async () => {
    const w = world.get();
    const leo = w.user("leo.martin");
    const ids = [await w.documentId(HERON), await w.documentId(POLICY), await w.documentId(CHECKLIST)];
    await w.t.sql`UPDATE documents SET status = 'ingesting' WHERE path = ${CHECKLIST}`;
    const decide = async (alias: string) => {
      const rows = await w.inTenant("kestrel", (tx) =>
        tx.execute<{ id: string; allowed: boolean }>(sql`
          SELECT ${sql.raw(alias)}.id, ${readable(leo, sql.raw(`${alias}.id`))} AS allowed
          FROM documents ${sql.raw(alias)} WHERE ${sql.raw(alias)}.id IN (${ids[0]}, ${ids[1]}, ${ids[2]})`),
      );
      const allowed = Object.fromEntries(rows.map((row) => [row.id, row.allowed]));
      return ids.map((id) => allowed[id]);
    };
    try {
      const expected = await decide("caller_documents");
      expect(expected, "the memo no, the policy yes, the checklist (ingesting) no").toEqual([false, true, false]);
      for (const alias of ["d", "a", "p", "u", "gc", "doc"]) {
        expect(
          await decide(alias),
          `called with \`${alias}.id\`: a subquery inside readable() that names its own table \`${alias}\` captures the ` +
            "caller's column. Give your subqueries' tables names no caller would use (acl_d, acl_a...)",
        ).toEqual(expected);
      }
    } finally {
      await w.t.sql`UPDATE documents SET status = 'ready' WHERE path = ${CHECKLIST}`;
    }
  });
});
