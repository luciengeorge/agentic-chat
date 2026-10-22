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

    it("throws 403 for a user the directory has disabled, and lets one it hasn't synced yet through", async () => {
      const userId = await createUser("sam.disabled", "kestrelpay.example");
      await auth.api.addMember({ body: { userId, organizationId: orgs.kestrel, role: "member" } });
      const sam = await sessionHeaders("sam.disabled@kestrelpay.example");
      expect((await getViewer(sam)).userId).toBe(userId);

      await t.sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, enabled, synced_at)
                  VALUES (${userId}, ${orgs.kestrel}, 'user', ${userId}, 'sam.disabled', 'Sam', false, now())`;
      const refused = await getViewer(sam).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(Response);
      expect((refused as Response).status).toBe(403);
      expect(await (refused as Response).json()).toEqual({ error: "disabled" });
    });
  });

  describe("the tenant comes from membership", () => {
    it("ends a removed member's sessions", async () => {
      await createUser("mia.leaving", "kestrelpay.example");
      await auth.api.addMember({
        body: { userId: users["mia.leaving"], organizationId: orgs.kestrel, role: "member" },
      });
      const mia = await sessionHeaders("mia.leaving@kestrelpay.example");
      expect((await getViewer(mia)).tenant.slug).toBe("kestrel");

      await auth.api.removeMember({
        body: { memberIdOrEmail: "mia.leaving@kestrelpay.example", organizationId: orgs.kestrel },
        headers: await sessionHeaders("tariq.aziz@kestrelpay.example"),
      });

      await expect(getViewer(mia)).rejects.toMatchObject({ status: 401 });
      expect(await t.sql`SELECT id FROM session WHERE user_id = ${users["mia.leaving"]}`).toEqual([]);
    });

    it("ends the sessions of a member who leaves, as it does for one removed", async () => {
      await createUser("max.leaver", "kestrelpay.example");
      await auth.api.addMember({
        body: { userId: users["max.leaver"], organizationId: orgs.kestrel, role: "member" },
      });
      const max = await sessionHeaders("max.leaver@kestrelpay.example");
      const other = await sessionHeaders("max.leaver@kestrelpay.example");
      max.set("content-type", "application/json");
      const left = await auth.handler(
        new Request("http://localhost:3000/api/auth/organization/leave", {
          method: "POST",
          headers: max,
          body: JSON.stringify({ organizationId: orgs.kestrel }),
        }),
      );
      expect(left.status).toBe(200);

      await expect(getViewer(max)).rejects.toMatchObject({ status: 401 });
      await expect(getViewer(other)).rejects.toMatchObject({ status: 401 });
      expect(await t.sql`SELECT id FROM session WHERE user_id = ${users["max.leaver"]}`).toEqual([]);
    });

    it("keeps the sessions of a member whose leave is refused", async () => {
      const leo = await sessionHeaders("leo.martin@kestrelpay.example");
      leo.set("content-type", "application/json");
      const refused = await auth.handler(
        new Request("http://localhost:3000/api/auth/organization/leave", {
          method: "POST",
          headers: leo,
          body: JSON.stringify({ organizationId: orgs.harbour }),
        }),
      );
      expect(refused.status).toBe(400);
      expect((await getViewer(leo)).tenant.slug).toBe("kestrel");
    });

    it("keeps a user's tenant after a refused set-active, which nulls the session's cache", async () => {
      const leo = await sessionHeaders("leo.martin@kestrelpay.example");
      await expect(
        auth.api.setActiveOrganization({ body: { organizationId: orgs.harbour }, headers: leo }),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect((await getViewer(leo)).tenant).toEqual({ id: orgs.kestrel, slug: "kestrel" });
    });
  });

  describe("invitations", () => {
    const refusal = { statusCode: 400, body: { message: "Invitations are off: membership comes from the directory" } };

    it("can't be sent", async () => {
      await expect(
        auth.api.createInvitation({
          body: { email: "new.hire@kestrelpay.example", role: "member", organizationId: orgs.kestrel },
          headers: await sessionHeaders("tariq.aziz@kestrelpay.example"),
        }),
      ).rejects.toMatchObject(refusal);
      expect(await t.sql`SELECT id FROM invitation`).toEqual([]);
    });

    it("can't be accepted, even one that exists", async () => {
      await createUser("invited.user", "harbourhealth.example");
      const [{ id }] = await t.sql`
        INSERT INTO invitation (organization_id, email, role, status, expires_at, inviter_id)
        VALUES (${orgs.harbour}, 'invited.user@harbourhealth.example', 'member', 'pending', now() + interval '1 day',
                ${users["david.cho"]})
        RETURNING id`;
      await expect(
        auth.api.acceptInvitation({
          body: { invitationId: id },
          headers: await sessionHeaders("invited.user@harbourhealth.example"),
        }),
      ).rejects.toMatchObject(refusal);
      expect(await t.sql`SELECT organization_id FROM member WHERE user_id = ${users["invited.user"]}`).toEqual([]);
    });
  });

  describe("an organization's slug", () => {
    const kestrel = () => t.sql`SELECT name, slug FROM organization WHERE id = ${orgs.kestrel}`;

    it("can't change", async () => {
      await expect(
        auth.api.updateOrganization({
          body: { organizationId: orgs.kestrel, data: { slug: "kestrel-pay" } },
          headers: await sessionHeaders("tariq.aziz@kestrelpay.example"),
        }),
      ).rejects.toMatchObject({ statusCode: 400, body: { message: "An organization's slug can't change" } });
      expect(await kestrel()).toEqual([{ name: "Kestrel Pay", slug: "kestrel" }]);
    });

    it("may be sent unchanged with the rest of an update", async () => {
      const tariq = await sessionHeaders("tariq.aziz@kestrelpay.example");
      const update = (name: string) =>
        auth.api.updateOrganization({
          body: { organizationId: orgs.kestrel, data: { name, slug: "kestrel" } },
          headers: tariq,
        });
      await update("Kestrel Pay Ltd");
      expect(await kestrel()).toEqual([{ name: "Kestrel Pay Ltd", slug: "kestrel" }]);
      await update("Kestrel Pay");
    });
  });

  it("refuses to sign in a banned user", async () => {
    await createUser("gone.user", "kestrelpay.example", { banned: true, banReason: "Left the company" });
    const response = await signIn("gone.user@kestrelpay.example");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "BANNED_USER" });
  });
});
