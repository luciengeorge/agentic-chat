// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SeedReport } from "@/db/seed";

import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { loadWorld } from "@/fixtures/world";
import { DEV_SECRETS } from "@/lib/auth-env";

const world = loadWorld();

const passwordFor = (email: string) =>
  Object.values(world.tenants).find((tenant) => email.endsWith(`@${tenant.domain}`))!.password;

const byEmail = (a: { email: string }, b: { email: string }) => (a.email < b.email ? -1 : 1);

describe.skipIf(!postgresAvailable)("seedWorld", () => {
  let t: TestDatabase;
  let modules: {
    db: typeof import("@/db/client").db;
    seedWorld: typeof import("@/db/seed").seedWorld;
    auth: typeof import("@/lib/auth").auth;
    getViewer: typeof import("@/lib/auth-server").getViewer;
  };
  let firstRun: SeedReport[];

  const seed = () => modules.seedWorld(world);

  function signIn(email: string) {
    return modules.auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: passwordFor(email) }),
      }),
    );
  }

  async function viewerOf(email: string) {
    const response = await signIn(email);
    expect(response.status, email).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ");
    return modules.getViewer(new Headers({ cookie }));
  }

  // What the seed is responsible for, in a form two runs can be compared by.
  const state = () => t.sql`
    SELECT u.id, u.email, u.name, u.email_verified, u.banned, u.updated_at, o.slug, m.role
    FROM "user" u
    LEFT JOIN member m ON m.user_id = u.id
    LEFT JOIN organization o ON o.id = m.organization_id
    ORDER BY u.email`;

  beforeAll(async () => {
    t = await createTestDatabase();
    // The db and auth modules read these at import, so they bind to this test's database.
    Object.assign(process.env, {
      DATABASE_URL: t.url,
      AC_ENV: "test",
      BETTER_AUTH_SECRET: DEV_SECRETS.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: "http://localhost:3000",
    });
    modules = {
      db: (await import("@/db/client")).db,
      seedWorld: (await import("@/db/seed")).seedWorld,
      auth: (await import("@/lib/auth")).auth,
      getViewer: (await import("@/lib/auth-server")).getViewer,
    };
    firstRun = await seed();
  }, 60_000);

  afterAll(async () => {
    await modules?.db.$client.end();
    await t?.drop();
  });

  it("creates the two organizations", async () => {
    expect(await t.sql`SELECT slug, name FROM organization ORDER BY slug`).toEqual([
      { slug: "harbour", name: "Harbour Health" },
      { slug: "kestrel", name: "Kestrel Pay" },
    ]);
  });

  it("creates every user with the world's id, verified, as a member of their tenant", async () => {
    const want = Object.values(world.tenants).flatMap((tenant) =>
      tenant.users.map((user) => ({
        id: world.userId(tenant.slug, user.username),
        email: user.email,
        name: user.name,
        email_verified: true,
        slug: tenant.slug,
        role: user.roles.includes("admin") ? "admin" : "member",
      })),
    );
    const got = (await state()).map(({ id, email, name, email_verified, slug, role }) => ({
      id,
      email,
      name,
      email_verified,
      slug,
      role,
    }));
    expect(got.sort(byEmail)).toEqual(want.sort(byEmail));
  });

  it("makes each tenant's directory admin an organization admin", async () => {
    const admins = await t.sql`SELECT u.email FROM member m JOIN "user" u ON u.id = m.user_id WHERE m.role = 'admin'`;
    expect(admins.map((row) => row.email).sort()).toEqual([
      "david.cho@harbourhealth.example",
      "tariq.aziz@kestrelpay.example",
    ]);
  });

  it("bans peter.hall and nobody else", async () => {
    const banned = await t.sql`SELECT email, ban_reason FROM "user" WHERE banned`;
    expect(banned).toEqual([{ email: "peter.hall@kestrelpay.example", ban_reason: expect.any(String) }]);
  });

  it("reports what it created", () => {
    const usernames = (slug: string) => world.tenant(slug).users.map((user) => user.username);
    expect(
      firstRun.map((report) => ({ ...report, membershipsCreated: [...report.membershipsCreated].sort() })),
    ).toEqual([
      {
        tenant: "kestrel",
        organizationCreated: true,
        usersCreated: usernames("kestrel"),
        membershipsCreated: [...usernames("kestrel")].sort(),
        banned: ["peter.hall"],
      },
      {
        tenant: "harbour",
        organizationCreated: true,
        usersCreated: usernames("harbour"),
        membershipsCreated: [...usernames("harbour")].sort(),
        banned: [],
      },
    ]);
  });

  it("signs each user into their own tenant", async () => {
    expect(await viewerOf("leo.martin@kestrelpay.example")).toMatchObject({
      userId: world.userId("kestrel", "leo.martin"),
      username: "leo.martin",
      name: "Leo Martin",
      tenant: { slug: "kestrel" },
    });
    expect((await viewerOf("nina.osei@harbourhealth.example")).tenant.slug).toBe("harbour");
    // The same username in both tenants: two people, each in their own.
    expect((await viewerOf("sam.patel@harbourhealth.example")).tenant.slug).toBe("harbour");
    expect((await viewerOf("sam.patel@kestrelpay.example")).tenant.slug).toBe("kestrel");
  });

  it("refuses peter.hall's sign-in", async () => {
    const response = await signIn("peter.hall@kestrelpay.example");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "BANNED_USER" });
  });

  it("changes nothing on a second run", async () => {
    const before = await state();
    expect(await seed()).toEqual(
      ["kestrel", "harbour"].map((tenant) => ({
        tenant,
        organizationCreated: false,
        usersCreated: [],
        membershipsCreated: [],
        banned: [],
      })),
    );
    expect(await state()).toEqual(before);
  });

  it("puts back what's missing, and bans peter.hall again", async () => {
    const withoutTimestamps = async () => (await state()).map(({ updated_at: _, ...row }) => row);
    const before = await withoutTimestamps();
    await t.sql`DELETE FROM member WHERE user_id = ${world.userId("kestrel", "leo.martin")}`;
    await t.sql`DELETE FROM "user" WHERE id = ${world.userId("harbour", "fatima.ali")}`;
    await t.sql`UPDATE "user" SET banned = false WHERE id = ${world.userId("kestrel", "peter.hall")}`;

    expect(await seed()).toEqual([
      {
        tenant: "kestrel",
        organizationCreated: false,
        usersCreated: [],
        membershipsCreated: ["leo.martin"],
        banned: ["peter.hall"],
      },
      {
        tenant: "harbour",
        organizationCreated: false,
        usersCreated: ["fatima.ali"],
        membershipsCreated: ["fatima.ali"],
        banned: [],
      },
    ]);
    expect(await withoutTimestamps()).toEqual(before);
    expect((await signIn("peter.hall@kestrelpay.example")).status).toBe(403);
  });

  it("refuses a user who already belongs to the other tenant", async () => {
    const orgs = Object.fromEntries((await t.sql`SELECT slug, id FROM organization`).map((row) => [row.slug, row.id]));
    const nina = world.userId("harbour", "nina.osei");
    await t.sql`UPDATE member SET organization_id = ${orgs.kestrel} WHERE user_id = ${nina}`;
    try {
      await expect(seed()).rejects.toThrow("nina.osei@harbourhealth.example already belongs to another organization");
    } finally {
      await t.sql`UPDATE member SET organization_id = ${orgs.harbour} WHERE user_id = ${nina}`;
    }
  });

  it("refuses to seed the public dev passwords in prod", async () => {
    const before = await state();
    process.env.AC_ENV = "prod";
    try {
      await expect(seed()).rejects.toThrow("AC_ENV=prod");
    } finally {
      process.env.AC_ENV = "test";
    }
    expect(await state()).toEqual(before);
  });
});
