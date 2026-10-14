// @vitest-environment node

import type postgres from "postgres";

import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as app from "./schema/app";
import * as auth from "./schema/auth";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "./testing";

const tableNames = (module: Record<string, unknown>) =>
  Object.values(module)
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => getTableName(table))
    .sort();

type Tx = postgres.TransactionSql;

const POLICY = "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)";

describe.skipIf(!postgresAvailable)("schema", () => {
  let t: TestDatabase;
  let kestrel: string;
  let harbour: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: kestrel }, { id: harbour }] = await t.sql`
      INSERT INTO organization (name, slug, created_at)
      VALUES ('Kestrel Pay', 'kestrel', now()), ('Harbour Health', 'harbour', now())
      RETURNING id`;
  });

  afterAll(async () => {
    await t?.drop();
  });

  // Runs the statements in a transaction that always rolls back, so tests can't see each other's
  // rows, and returns what it threw: the database error, or ROLLED_BACK when every statement passed.
  const ROLLED_BACK = new Error("rolled back");
  function attempt(statements: (sql: Tx) => Promise<unknown>): Promise<unknown> {
    return t.sql
      .begin(async (sql) => {
        await statements(sql);
        throw ROLLED_BACK;
      })
      .catch((error: unknown) => error);
  }

  async function principal(sql: Tx, tenantId: string, kind: "user" | "group", name: string) {
    const [row] = await sql`
      INSERT INTO principals (tenant_id, kind, external_id, name, display_name, enabled, synced_at)
      VALUES (${tenantId}, ${kind}, ${name}, ${name}, ${name}, true, now())
      RETURNING id`;
    return row.id as string;
  }

  async function document(sql: Tx, tenantId: string, status = "ready") {
    const [row] = await sql`
      INSERT INTO documents (tenant_id, source, external_id, title, path, mime_type, version, source_version,
        content_hash, status)
      VALUES (${tenantId}, 'workspace', gen_random_uuid()::text, 'Memo', '/Memo.md', 'text/markdown', 1, 'v1',
        'sha256:0', ${status})
      RETURNING id`;
    return row.id as string;
  }

  interface Parents {
    user: string;
    group: string;
    document: string;
    conversation: string;
    run: string;
  }

  // One row of each kind that other tables point at, in the tenant.
  async function parents(sql: Tx, tenantId: string): Promise<Parents> {
    const user = await principal(sql, tenantId, "user", "leo.martin");
    const group = await principal(sql, tenantId, "group", "/Finance");
    const [conversation] = await sql`
      INSERT INTO conversations (tenant_id, user_id) VALUES (${tenantId}, ${user}) RETURNING id`;
    const [run] = await sql`
      INSERT INTO runs (tenant_id, user_id, kind, status) VALUES (${tenantId}, ${user}, 'chat', 'queued') RETURNING id`;
    return { user, group, document: await document(sql, tenantId), conversation: conversation.id, run: run.id };
  }

  it("enables and forces RLS with the tenant policy on every app table, and on no auth table", async () => {
    const rows = await t.sql`
      SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
        p.policyname, p.cmd, p.permissive, p.qual, p.with_check
      FROM pg_class c
      LEFT JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = c.relname
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'`;
    const byTable = new Map(rows.map((row) => [row.table as string, row]));

    for (const table of tableNames(app)) {
      expect(byTable.get(table), table).toMatchObject({
        enabled: true,
        forced: true,
        policyname: "tenant_isolation",
        cmd: "ALL",
        permissive: "PERMISSIVE",
        qual: POLICY,
        with_check: null,
      });
    }
    for (const table of tableNames(auth)) {
      expect(byTable.get(table), table).toMatchObject({ enabled: false, policyname: null });
    }
  });

  it("covers the tables the M0b schema had, M1's document_blobs and rate_limit_buckets, and M2's agent tables and jobs", () => {
    expect(tableNames(app)).toEqual(
      [
        "agent_budgets",
        "agent_switches",
        "approvals",
        "chunks",
        "conversations",
        "document_acl",
        "document_blobs",
        "documents",
        "group_closure",
        "group_members",
        "jobs",
        "memory_notes",
        "messages",
        "outbox",
        "principals",
        "rate_limit_buckets",
        "retrieval_audit",
        "run_events",
        "runs",
        "sync_state",
      ].sort(),
    );
  });

  it("shows a role without BYPASSRLS only the rows of the tenant in app.tenant_id", async () => {
    const role = `ac_rls_probe_${randomUUID().slice(0, 8)}`;
    const seen: Record<string, string[]> = {};
    const error = await attempt(async (sql) => {
      await principal(sql, kestrel, "user", "leo.martin");
      await principal(sql, harbour, "user", "nina.osei");
      // CREATE ROLE is transactional, so the rollback removes it too.
      await sql.unsafe(`CREATE ROLE "${role}"`);
      await sql.unsafe(`GRANT SELECT, INSERT ON principals TO "${role}"`);
      await sql.unsafe(`SET LOCAL ROLE "${role}"`);

      const names = async () => (await sql`SELECT name FROM principals ORDER BY name`).map((row) => row.name);
      seen.unset = await names();
      for (const [label, value] of [
        ["kestrel", kestrel],
        ["harbour", harbour],
        ["empty", ""],
      ]) {
        await sql`SELECT set_config('app.tenant_id', ${value}, true)`;
        seen[label] = await names();
      }

      await sql`SELECT set_config('app.tenant_id', ${kestrel}, true)`;
      await sql`
        INSERT INTO principals (tenant_id, kind, external_id, name, display_name, enabled, synced_at)
        VALUES (${harbour}, 'user', 'x', 'x', 'x', true, now())`;
    });

    expect(seen).toEqual({ unset: [], kestrel: ["leo.martin"], harbour: ["nina.osei"], empty: [] });
    // The policy has no WITH CHECK, so its USING clause also guards writes.
    expect(error).toMatchObject({ code: "42501", message: expect.stringContaining("row-level security") });
  });

  // Why the comment in schema/app.ts says what binds: forcing RLS reaches a table's owner, never a superuser.
  it("shows the dev role every tenant's rows, even with RLS forced, since it bypasses RLS", async () => {
    let names: string[] = [];
    await attempt(async (sql) => {
      await principal(sql, kestrel, "user", "leo.martin");
      await principal(sql, harbour, "user", "nina.osei");
      await sql`ALTER TABLE principals FORCE ROW LEVEL SECURITY`;
      await sql`SELECT set_config('app.tenant_id', ${kestrel}, true)`;
      names = (await sql`SELECT name FROM principals ORDER BY name`).map((row) => row.name);
    });
    expect(names).toEqual(["leo.martin", "nina.osei"]);
    expect(await t.sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`).toEqual([
      { rolsuper: true, rolbypassrls: true },
    ]);
  });

  // Each child row is Harbour's and points at exactly one Kestrel parent.
  const CROSS_TENANT_FKS: [string, (sql: Tx, own: Parents, other: Parents) => Promise<unknown>][] = [
    [
      "group_members_tenant_id_group_id_fkey",
      (sql, own, other) =>
        sql`INSERT INTO group_members (tenant_id, group_id, member_id) VALUES (${harbour}, ${other.group}, ${own.user})`,
    ],
    [
      "group_members_tenant_id_member_id_fkey",
      (sql, own, other) =>
        sql`INSERT INTO group_members (tenant_id, group_id, member_id) VALUES (${harbour}, ${own.group}, ${other.user})`,
    ],
    [
      "group_closure_tenant_id_group_id_fkey",
      (sql, own, other) => sql`
        INSERT INTO group_closure (tenant_id, group_id, member_id, depth)
        VALUES (${harbour}, ${other.group}, ${own.user}, 1)`,
    ],
    [
      "group_closure_tenant_id_member_id_fkey",
      (sql, own, other) => sql`
        INSERT INTO group_closure (tenant_id, group_id, member_id, depth)
        VALUES (${harbour}, ${own.group}, ${other.user}, 1)`,
    ],
    [
      "document_acl_tenant_id_document_id_fkey",
      (sql, own, other) => sql`
        INSERT INTO document_acl (tenant_id, document_id, principal_id, effect, acl_version)
        VALUES (${harbour}, ${other.document}, ${own.user}, 'allow', 1)`,
    ],
    [
      "document_acl_tenant_id_principal_id_fkey",
      (sql, own, other) => sql`
        INSERT INTO document_acl (tenant_id, document_id, principal_id, effect, acl_version)
        VALUES (${harbour}, ${own.document}, ${other.user}, 'allow', 1)`,
    ],
    [
      "chunks_tenant_id_document_id_fkey",
      (sql, _own, other) => sql`
        INSERT INTO chunks (tenant_id, document_id, document_version, ordinal, text, token_count)
        VALUES (${harbour}, ${other.document}, 1, 0, 'text', 1)`,
    ],
    [
      "conversations_tenant_id_user_id_fkey",
      (sql, _own, other) => sql`INSERT INTO conversations (tenant_id, user_id) VALUES (${harbour}, ${other.user})`,
    ],
    [
      "messages_tenant_id_conversation_id_fkey",
      (sql, _own, other) => sql`
        INSERT INTO messages (tenant_id, conversation_id, seq, role, content)
        VALUES (${harbour}, ${other.conversation}, 1, 'user', '{}')`,
    ],
    [
      "retrieval_audit_tenant_id_user_id_fkey",
      (sql, _own, other) => sql`
        INSERT INTO retrieval_audit (tenant_id, user_id, query_hash, returned_ids, denied_ids, acl_version)
        VALUES (${harbour}, ${other.user}, 'sha256:0', '{}', '{}', 0)`,
    ],
    [
      "rate_limit_buckets_tenant_id_user_id_fkey",
      (sql, _own, other) => sql`
        INSERT INTO rate_limit_buckets (tenant_id, user_id, bucket, tokens, refilled_at)
        VALUES (${harbour}, ${other.user}, 'chat', 1, now())`,
    ],
    [
      "runs_tenant_id_user_id_fkey",
      (sql, _own, other) =>
        sql`INSERT INTO runs (tenant_id, user_id, kind, status) VALUES (${harbour}, ${other.user}, 'chat', 'queued')`,
    ],
    [
      "runs_tenant_id_conversation_id_fkey",
      (sql, own, other) => sql`
        INSERT INTO runs (tenant_id, user_id, conversation_id, kind, status)
        VALUES (${harbour}, ${own.user}, ${other.conversation}, 'chat', 'queued')`,
    ],
    [
      "runs_tenant_id_parent_run_id_fkey",
      (sql, own, other) => sql`
        INSERT INTO runs (tenant_id, user_id, parent_run_id, kind, status)
        VALUES (${harbour}, ${own.user}, ${other.run}, 'subagent', 'queued')`,
    ],
    [
      "run_events_tenant_id_run_id_fkey",
      (sql, _own, other) => sql`
        INSERT INTO run_events (tenant_id, run_id, seq, type, data)
        VALUES (${harbour}, ${other.run}, 1, 'status', '{"type": "status"}')`,
    ],
    [
      "approvals_tenant_id_run_id_fkey",
      (sql, _own, other) => sql`
        INSERT INTO approvals (tenant_id, run_id, call_id, tool, input, expires_at)
        VALUES (${harbour}, ${other.run}, 'c1', 'send_mail', '{}', now())`,
    ],
    [
      "memory_notes_tenant_id_user_id_fkey",
      (sql, _own, other) =>
        sql`INSERT INTO memory_notes (tenant_id, user_id, text) VALUES (${harbour}, ${other.user}, 'note')`,
    ],
    [
      "agent_budgets_tenant_id_user_id_fkey",
      (sql, _own, other) => sql`
        INSERT INTO agent_budgets (tenant_id, user_id, day, token_limit)
        VALUES (${harbour}, ${other.user}, current_date, 1)`,
    ],
  ];

  it.each(CROSS_TENANT_FKS)("%s refuses a row that points into another tenant", async (constraint, insert) => {
    const error = await attempt(async (sql) => insert(sql, await parents(sql, harbour), await parents(sql, kestrel)));
    expect(error).toMatchObject({ code: "23503", constraint_name: constraint });
  });

  it("has a cross-tenant case for every composite FK", async () => {
    const rows = await t.sql`
      SELECT conname FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace AND contype = 'f' AND cardinality(conkey) = 2`;
    expect(rows.map((row) => row.conname).sort()).toEqual(CROSS_TENANT_FKS.map(([name]) => name).sort());
  });

  it("accepts the same row inside its own tenant", async () => {
    expect(
      await attempt(async (sql) => {
        const group = await principal(sql, kestrel, "group", "/Kestrel/Exec");
        const user = await principal(sql, kestrel, "user", "amara.okafor");
        await sql`INSERT INTO group_members (tenant_id, group_id, member_id) VALUES (${kestrel}, ${group}, ${user})`;
      }),
    ).toBe(ROLLED_BACK);
  });

  describe("chunks_pages_check", () => {
    const insertChunk = (pageStart: number | null, pageEnd: number | null) => async (sql: Tx) => {
      const documentId = await document(sql, kestrel);
      await sql`
        INSERT INTO chunks (tenant_id, document_id, document_version, ordinal, text, page_start, page_end, token_count)
        VALUES (${kestrel}, ${documentId}, 1, 0, 'text', ${pageStart}, ${pageEnd}, 1)`;
    };

    it.each([
      [null, null],
      [3, 3],
      [3, 5],
    ])("accepts pages %s to %s", async (start, end) => {
      expect(await attempt(insertChunk(start, end))).toBe(ROLLED_BACK);
    });

    it.each([
      [3, null],
      [null, 3],
      [5, 3],
    ])("refuses pages %s to %s", async (start, end) => {
      expect(await attempt(insertChunk(start, end))).toMatchObject({
        code: "23514",
        constraint_name: "chunks_pages_check",
      });
    });
  });

  describe("group_closure checks", () => {
    const insertClosure = (self: boolean, depth: number) => async (sql: Tx) => {
      const group = await principal(sql, kestrel, "group", "/Kestrel");
      const member = self ? group : await principal(sql, kestrel, "user", "ella.brooks");
      await sql`
        INSERT INTO group_closure (tenant_id, group_id, member_id, depth)
        VALUES (${kestrel}, ${group}, ${member}, ${depth})`;
    };

    it("accepts a direct member at depth 1", async () => {
      expect(await attempt(insertClosure(false, 1))).toBe(ROLLED_BACK);
    });

    it("refuses a self row", async () => {
      expect(await attempt(insertClosure(true, 1))).toMatchObject({
        code: "23514",
        constraint_name: "group_closure_no_self_check",
      });
    });

    it("refuses depth 0", async () => {
      expect(await attempt(insertClosure(false, 0))).toMatchObject({
        code: "23514",
        constraint_name: "group_closure_depth_check",
      });
    });
  });

  describe("messages_content_check", () => {
    const insertMessage = (content: string) => async (sql: Tx) => {
      const user = await principal(sql, kestrel, "user", "leo.martin");
      const [conversation] = await sql`
        INSERT INTO conversations (tenant_id, user_id) VALUES (${kestrel}, ${user}) RETURNING id`;
      await sql`
        INSERT INTO messages (tenant_id, conversation_id, seq, role, content)
        VALUES (${kestrel}, ${conversation.id}, 1, 'user', ${content}::jsonb)`;
    };

    it.each(['{"text": "hi"}', '[{"type": "text"}]'])("accepts %s", async (content) => {
      expect(await attempt(insertMessage(content))).toBe(ROLLED_BACK);
    });

    it.each(["null", '"hi"', "42"])("refuses %s", async (content) => {
      expect(await attempt(insertMessage(content))).toMatchObject({
        code: "23514",
        constraint_name: "messages_content_check",
      });
    });
  });

  it.each<[string, (sql: Tx, p: Parents) => Promise<unknown>]>([
    [
      "principals_kind_check",
      (sql) => sql`
        INSERT INTO principals (tenant_id, kind, external_id, name, display_name, enabled, synced_at)
        VALUES (${kestrel}, 'robot', 'x', 'x', 'x', true, now())`,
    ],
    ["documents_status_check", (sql) => document(sql, kestrel, "archived")],
    [
      "document_acl_effect_check",
      (sql, p) => sql`
        INSERT INTO document_acl (tenant_id, document_id, principal_id, effect, acl_version)
        VALUES (${kestrel}, ${p.document}, ${p.user}, 'maybe', 1)`,
    ],
    [
      "messages_role_check",
      (sql, p) => sql`
        INSERT INTO messages (tenant_id, conversation_id, seq, role, content)
        VALUES (${kestrel}, ${p.conversation}, 1, 'robot', '{}')`,
    ],
  ])("%s refuses a value outside its list", async (constraint, insert) => {
    expect(await attempt(async (sql) => insert(sql, await parents(sql, kestrel)))).toMatchObject({
      code: "23514",
      constraint_name: constraint,
    });
  });

  describe("messages keys", () => {
    const insertMessages =
      (...rows: [seq: number, key: string | null][]) =>
      async (sql: Tx) => {
        const { conversation } = await parents(sql, kestrel);
        for (const [seq, key] of rows) {
          await sql`
            INSERT INTO messages (tenant_id, conversation_id, seq, role, content, idempotency_key)
            VALUES (${kestrel}, ${conversation}, ${seq}, 'user', '{}', ${key})`;
        }
      };

    it("refuses a second message at the same seq", async () => {
      expect(await attempt(insertMessages([1, "a"], [1, "b"]))).toMatchObject({
        code: "23505",
        constraint_name: "messages_conversation_id_seq_key",
      });
    });

    it("refuses a repeated idempotency key", async () => {
      expect(await attempt(insertMessages([1, "a"], [2, "a"]))).toMatchObject({
        code: "23505",
        constraint_name: "messages_conversation_id_idempotency_key_key",
      });
    });

    it("lets any number of messages go without a key", async () => {
      expect(await attempt(insertMessages([1, null], [2, null]))).toBe(ROLLED_BACK);
    });
  });

  it("deletes a document's chunks and ACL rows with it, and a conversation's messages", async () => {
    let left: unknown;
    const outcome = await attempt(async (sql) => {
      const p = await parents(sql, kestrel);
      await sql`
        INSERT INTO chunks (tenant_id, document_id, document_version, ordinal, text, token_count)
        VALUES (${kestrel}, ${p.document}, 1, 0, 'text', 1)`;
      await sql`
        INSERT INTO document_acl (tenant_id, document_id, principal_id, effect, acl_version)
        VALUES (${kestrel}, ${p.document}, ${p.user}, 'allow', 1)`;
      await sql`
        INSERT INTO messages (tenant_id, conversation_id, seq, role, content)
        VALUES (${kestrel}, ${p.conversation}, 1, 'user', '{}')`;
      await sql`DELETE FROM documents WHERE id = ${p.document}`;
      await sql`DELETE FROM conversations WHERE id = ${p.conversation}`;
      [left] = await sql`
        SELECT (SELECT count(*) FROM chunks)::int AS chunks, (SELECT count(*) FROM document_acl)::int AS acl,
          (SELECT count(*) FROM messages)::int AS messages`;
    });
    expect(outcome).toBe(ROLLED_BACK);
    expect(left).toEqual({ chunks: 0, acl: 0, messages: 0 });
  });

  it("draws increasing acl versions from one sequence with cache 1", async () => {
    const [{ cache_size }] = await t.sql`SELECT cache_size FROM pg_sequences WHERE sequencename = 'acl_version_seq'`;
    expect(Number(cache_size)).toBe(1);

    const [{ mark: before }] = await t.sql`
      SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS mark FROM acl_version_seq`;
    const drawn: number[] = [];
    for (let i = 0; i < 3; i++) {
      const [{ v }] = await t.sql`SELECT nextval('acl_version_seq') AS v`;
      drawn.push(Number(v));
    }
    expect(drawn[0]).toBeGreaterThan(Number(before));
    expect(drawn[1]).toBeGreaterThan(drawn[0]);
    expect(drawn[2]).toBeGreaterThan(drawn[1]);
  });
});
