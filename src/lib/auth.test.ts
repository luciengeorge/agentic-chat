// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { DEV_SECRETS } from "@/lib/auth-env";

const PASSWORD = "dev-password";

describe.skipIf(!postgresAvailable)("auth", () => {
  let t: TestDatabase;
  let auth: typeof import("@/lib/auth").auth;
  let getViewer: typeof import("@/lib/auth-server").getViewer;
  const users: Record<string, string> = {};
  const orgs: Record<string, string> = {};

  async function createUser(username: string, domain: string, data: Record<string, unknown> = {}) {
    const { user } = await auth.api.createUser({
      body: {
        email: `${username}@${domain}`,
        password: PASSWORD,
        name: username,
        data: { emailVerified: true, ...data },
      },
    });
    users[username] = user.id;
    return user.id;
  }

  async function signIn(email: string) {
    return auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
  }

  async function sessionHeaders(email: string) {
    const response = await signIn(email);
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ");
    return new Headers({ cookie });
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    // The auth modules read these at import, so they bind to this test's database.
    Object.assign(process.env, {
      DATABASE_URL: t.url,
      AC_ENV: "test",
      BETTER_AUTH_SECRET: DEV_SECRETS.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: "http://localhost:3000",
    });
    ({ auth } = await import("@/lib/auth"));
    ({ getViewer } = await import("@/lib/auth-server"));

    for (const [slug, name, creator, domain] of [
      ["kestrel", "Kestrel Pay", "tariq.aziz", "kestrelpay.example"],
      ["harbour", "Harbour Health", "david.cho", "harbourhealth.example"],
    ]) {
      const organization = await auth.api.createOrganization({
        body: { name, slug, userId: await createUser(creator, domain) },
      });
      orgs[slug] = organization!.id;
    }
    await createUser("leo.martin", "kestrelpay.example");
    await auth.api.addMember({ body: { userId: users["leo.martin"], organizationId: orgs.kestrel, role: "member" } });
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("makes the seeding admin the organization's admin, not its owner", async () => {
    const rows = await t.sql`SELECT role FROM member WHERE user_id = ${users["tariq.aziz"]}`;
    expect(rows).toEqual([{ role: "admin" }]);
  });

  it("keeps the ids it is given", async () => {
    const id = "7f8a0d58-52cc-5bd1-9a3c-1f0a4c1d2e3f";
    await createUser("fixed.id", "kestrelpay.example", { id });
    expect(users["fixed.id"]).toBe(id);
  });

  describe("one organization per user", () => {
    it("refuses a second membership through addMember", async () => {
      await expect(
        auth.api.addMember({ body: { userId: users["leo.martin"], organizationId: orgs.harbour, role: "member" } }),
      ).rejects.toMatchObject({ statusCode: 400, body: { message: "A user can belong to one organization only" } });
    });

    it("refuses a second membership in the database too", async () => {
      await expect(
        t.sql`INSERT INTO member (organization_id, user_id, role, created_at)
              VALUES (${orgs.harbour}, ${users["leo.martin"]}, 'member', now())`,
      ).rejects.toMatchObject({ code: "23505", constraint_name: "member_user_id_key" });
    });

    it("doesn't let a signed-in user create an organization", async () => {
      await expect(
        auth.api.createOrganization({
          body: { name: "Side Project", slug: "side-project" },
          headers: await sessionHeaders("leo.martin@kestrelpay.example"),
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  describe("getViewer", () => {
    it("returns the user and their tenant", async () => {
      expect(await getViewer(await sessionHeaders("leo.martin@kestrelpay.example"))).toEqual({
        userId: users["leo.martin"],
        email: "leo.martin@kestrelpay.example",
        username: "leo.martin",
        name: "leo.martin",
        tenant: { id: orgs.kestrel, slug: "kestrel" },
      });
    });

    it("returns the other tenant for its users", async () => {
      const viewer = await getViewer(await sessionHeaders("david.cho@harbourhealth.example"));
      expect(viewer.tenant).toEqual({ id: orgs.harbour, slug: "harbour" });
    });

    it("throws 401 without a session", async () => {
      await expect(getViewer(new Headers())).rejects.toMatchObject({ status: 401 });
    });

    it("throws 403 for a user with no organization", async () => {
      await createUser("no.org", "kestrelpay.example");
      await expect(getViewer(await sessionHeaders("no.org@kestrelpay.example"))).rejects.toMatchObject({
        status: 403,
      });
    });
  });

  it("refuses to sign in a banned user", async () => {
    await createUser("gone.user", "kestrelpay.example", { banned: true, banReason: "Left the company" });
    const response = await signIn("gone.user@kestrelpay.example");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "BANNED_USER" });
  });
});
