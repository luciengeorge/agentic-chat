// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import type { SeedReport } from "@/db/seed";

import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { DEFAULT_WORLD_PATH, loadWorld, type World } from "@/fixtures/world";
import { DEV_SECRETS } from "@/lib/auth-env";

const world = loadWorld();

type UserData = { username: string; name: string; roles?: string[]; enabled?: boolean };
type WorldData = { id_namespace: string; tenants: Record<string, { domain: string; users: UserData[] }> };

/** world.yaml with `edit` applied, loaded the way the seed loads it. */
function worldWith(edit: (data: WorldData) => void): World {
  const data = parse(readFileSync(DEFAULT_WORLD_PATH, "utf8")) as WorldData;
  edit(data);
  const dir = mkdtempSync(join(tmpdir(), "world-"));
  try {
    writeFileSync(join(dir, "world.yaml"), stringify(data));
    return loadWorld(join(dir, "world.yaml"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const userIn = (data: WorldData, tenant: string, username: string) =>
  data.tenants[tenant].users.find((user) => user.username === username)!;

const NO_CHANGES = {
  usersCreated: [],
  usersUpdated: [],
  membershipsCreated: [],
  rolesUpdated: [],
  banned: [],
  unbanned: [],
};

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

  const seed = (w: World = world) => modules.seedWorld(w);

  function signIn(email: string, password = passwordFor(email)) {
    return modules.auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
  }

  async function viewerOf(email: string, password?: string) {
    const response = await signIn(email, password);
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
        ...NO_CHANGES,
        tenant: "kestrel",
        organizationCreated: true,
        usersCreated: usernames("kestrel"),
        membershipsCreated: [...usernames("kestrel")].sort(),
        banned: ["peter.hall"],
      },
      {
        ...NO_CHANGES,
        tenant: "harbour",
        organizationCreated: true,
        usersCreated: usernames("harbour"),
        membershipsCreated: [...usernames("harbour")].sort(),
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
      ["kestrel", "harbour"].map((tenant) => ({ ...NO_CHANGES, tenant, organizationCreated: false })),
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
        ...NO_CHANGES,
        tenant: "kestrel",
        organizationCreated: false,
        membershipsCreated: ["leo.martin"],
        banned: ["peter.hall"],
      },
      {
        ...NO_CHANGES,
        tenant: "harbour",
        organizationCreated: false,
        usersCreated: ["fatima.ali"],
        membershipsCreated: ["fatima.ali"],
      },
    ]);
    expect(await withoutTimestamps()).toEqual(before);
    expect((await signIn("peter.hall@kestrelpay.example")).status).toBe(403);
  });

  describe("repairs what the world says differently", () => {
    const withoutTimestamps = async () => (await state()).map(({ updated_at: _, ...row }) => row);

    it("follows a user's new name, role and enabled flag, and back", async () => {
      const before = await withoutTimestamps();
      const changed = worldWith((data) => {
        Object.assign(userIn(data, "kestrel", "leo.martin"), { name: "Leo Martin-Shaw", roles: ["employee", "admin"] });
        userIn(data, "kestrel", "peter.hall").enabled = true;
        userIn(data, "kestrel", "sam.patel").enabled = false;
      });

      expect(await seed(changed)).toEqual([
        {
          ...NO_CHANGES,
          tenant: "kestrel",
          organizationCreated: false,
          usersUpdated: ["leo.martin"],
          rolesUpdated: ["leo.martin"],
          banned: ["sam.patel"],
          unbanned: ["peter.hall"],
        },
        { ...NO_CHANGES, tenant: "harbour", organizationCreated: false },
      ]);
      const leo = world.userId("kestrel", "leo.martin");
      expect(
        await t.sql`SELECT u.name, m.role FROM "user" u JOIN member m ON m.user_id = u.id WHERE u.id = ${leo}`,
      ).toEqual([{ name: "Leo Martin-Shaw", role: "admin" }]);
      expect((await signIn("peter.hall@kestrelpay.example")).status).toBe(200);
      expect((await signIn("sam.patel@kestrelpay.example")).status).toBe(403);

      expect(await seed()).toEqual([
        {
          ...NO_CHANGES,
          tenant: "kestrel",
          organizationCreated: false,
          usersUpdated: ["leo.martin"],
          rolesUpdated: ["leo.martin"],
          banned: ["peter.hall"],
          unbanned: ["sam.patel"],
        },
        { ...NO_CHANGES, tenant: "harbour", organizationCreated: false },
      ]);
      expect(await withoutTimestamps()).toEqual(before);
      expect((await signIn("peter.hall@kestrelpay.example")).status).toBe(403);
    });

    it("moves a tenant's users to a new domain, and back", async () => {
      const before = await withoutTimestamps();
      const harbour = world.tenant("harbour").users.map((user) => user.username);
      const moved = worldWith((data) => {
        data.tenants.harbour.domain = "harbour.example";
      });

      expect(await seed(moved)).toEqual([
        { ...NO_CHANGES, tenant: "kestrel", organizationCreated: false },
        { ...NO_CHANGES, tenant: "harbour", organizationCreated: false, usersUpdated: harbour },
      ]);
      const password = moved.tenant("harbour").password;
      expect((await viewerOf("nina.osei@harbour.example", password)).tenant.slug).toBe("harbour");

      await seed();
      expect(await withoutTimestamps()).toEqual(before);
    });

    it("puts back an email changed in the database", async () => {
      const before = await withoutTimestamps();
      await t.sql`UPDATE "user" SET email = 'leo@elsewhere.example' WHERE id = ${world.userId("kestrel", "leo.martin")}`;
      expect((await seed())[0].usersUpdated).toEqual(["leo.martin"]);
      expect(await withoutTimestamps()).toEqual(before);
    });

    it("stops at a user whose email has another id than the world's", async () => {
      const before = await state();
      const renumbered = worldWith((data) => {
        data.id_namespace = "00000000-0000-4000-8000-000000000000";
      });
      const amara = { email: "amara.okafor@kestrelpay.example", id: world.userId("kestrel", "amara.okafor") };
      await expect(seed(renumbered)).rejects.toThrow(
        `${amara.email} has the id ${amara.id} in the database, but the world gives it ${renumbered.userId("kestrel", "amara.okafor")}`,
      );
      expect(await state()).toEqual(before);
    });
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
