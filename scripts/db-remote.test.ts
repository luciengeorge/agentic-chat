// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { describeUrl, migrateRemote, rotatePasswords, targetProblems } from "./db-remote";

const ADMIN = "postgres://owner:owner-pass@db.example.com:5432/ac?sslmode=require";
const APP = "postgres://ac_app:0123456789abcdef0123@db.example.com:5432/ac?sslmode=require";

describe("the remote migration's checks", () => {
  it("accepts an owner and the app role on one database", () => {
    expect(targetProblems({ DATABASE_ADMIN_URL: ADMIN, DATABASE_URL: APP })).toEqual([]);
  });

  it("names both URLs when they're missing", () => {
    expect(targetProblems({})).toEqual([
      "DATABASE_ADMIN_URL must be set: the owner runs the migrations",
      "DATABASE_URL must be set: ac_app's password comes from it",
    ]);
  });

  it("refuses the dev password, another role, and two different databases", () => {
    const short = targetProblems({
      DATABASE_ADMIN_URL: ADMIN,
      DATABASE_URL: APP.replace("0123456789abcdef0123", "ac_app"),
    });
    expect(short).toEqual(["ac_app's password is 6 characters; use 16 or more (openssl rand -hex 16)"]);
    expect(targetProblems({ DATABASE_ADMIN_URL: ADMIN, DATABASE_URL: ADMIN })).toContain(
      'DATABASE_URL must connect as ac_app, not "owner"',
    );
    expect(targetProblems({ DATABASE_ADMIN_URL: APP, DATABASE_URL: APP })).toContain(
      "DATABASE_ADMIN_URL must be the owner, not ac_app",
    );
    expect(targetProblems({ DATABASE_ADMIN_URL: ADMIN.replace("/ac?", "/other?"), DATABASE_URL: APP })).toEqual([
      "the two URLs point at different databases: db.example.com:5432/other and db.example.com:5432/ac",
    ]);
  });

  it("prints a target without its password", () => {
    expect(describeUrl(ADMIN)).toBe("owner@db.example.com:5432/ac");
  });
});

describe.skipIf(!postgresAvailable)("the remote migration on a fresh database", () => {
  let t: TestDatabase;
  const lines: string[] = [];

  beforeAll(async () => {
    t = await createTestDatabase({ migrated: false });
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("migrates, enables the app role, and checks that row-level security binds it", async () => {
    const report = await migrateRemote(t.url, t.appUrl, (line) => lines.push(line));
    expect(report.applied).toBe(report.total);
    expect(report.total).toBeGreaterThan(10);
    expect(Object.keys(report.extensions)).toEqual(["pg_search", "vector"]);
    expect(report.appRole).toEqual({ user: "ac_app", bypassesRls: false, documentsWithoutTenant: 0 });
    expect(lines.join("\n")).not.toContain(`:${new URL(t.appUrl).password}@`);
    expect(lines[0]).toMatch(/^target ac@.+, Postgres 18/);
  });

  it("applies nothing the second time", async () => {
    const report = await migrateRemote(t.url, t.appUrl, () => {});
    expect(report.applied).toBe(0);
  });

  it("refuses an owner bound by row-level security before changing anything", async () => {
    const role = `ac_test_owner_${Date.now().toString(36)}`;
    await t.sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'owner-pass' NOSUPERUSER NOBYPASSRLS`);
    try {
      const url = new URL(t.url);
      url.username = role;
      url.password = "owner-pass";
      await expect(migrateRemote(url.toString(), t.appUrl, () => {})).rejects.toThrow(/superuser or have BYPASSRLS/);
    } finally {
      await t.sql.unsafe(`DROP ROLE ${role}`);
    }
  });
});

describe("rotating the passwords", () => {
  it("refuses a short password and the dev database, before connecting", async () => {
    await expect(rotatePasswords(ADMIN, "short")).rejects.toThrow("the new password is 5 characters; use 12 or more");
    await expect(rotatePasswords("postgres://ac:ac@localhost:5432/ac", "a-long-enough-password")).rejects.toThrow(
      "that's the dev database",
    );
  });
});

describe.skipIf(!postgresAvailable)("rotating the passwords on a copied database", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("gives every account the new password, which better-auth accepts and the old one doesn't, and ends sessions", async () => {
    const { hashPassword, verifyPassword } = await import("better-auth/crypto");
    const old = await hashPassword("dev-password");
    const [{ id }] = await t.sql`
      INSERT INTO "user" (name, email, email_verified) VALUES ('Leo Martin', 'leo.martin@kestrelpay.example', true)
      RETURNING id`;
    await t.sql`INSERT INTO account (account_id, provider_id, user_id, password, updated_at)
                VALUES (${id}, 'credential', ${id}, ${old}, now())`;
    await t.sql`INSERT INTO session (expires_at, token, updated_at, user_id)
                VALUES (now() + interval '1 day', 'copied-session', now(), ${id})`;

    expect(await rotatePasswords(t.url, "a-new-password-for-the-deploy")).toEqual({ accounts: 1, sessions: 1 });
    const [{ password }] = await t.sql`SELECT password FROM account`;
    expect(await verifyPassword({ hash: password, password: "a-new-password-for-the-deploy" })).toBe(true);
    expect(await verifyPassword({ hash: password, password: "dev-password" })).toBe(false);
    const [{ count }] = await t.sql`SELECT count(*)::int AS count FROM session`;
    expect(count).toBe(0);
  });
});
