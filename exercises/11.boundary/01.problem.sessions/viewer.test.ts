// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Session } from "#learn/boundary/viewer";

import { resolveViewer } from "#learn/boundary/viewer";
import { setupAclWorld } from "@/core/acl/testing";
import { withTenantOn } from "@/db/tenant";
import { postgresAvailable } from "@/db/testing";
import { loadWorld } from "@/fixtures/world";
import { DEV_SECRETS } from "@/lib/auth-env";

const world = setupAclWorld({ drive: false });
const directory = loadWorld();

describe.skipIf(!postgresAvailable)("who is asking", () => {
  let auth: typeof import("@/lib/auth").auth;
  let closeAuthDb: () => Promise<void>;

  const passwordOf = (email: string) =>
    Object.values(directory.tenants).find((t) => email.endsWith(`@${t.domain}`))!.password;

  async function signIn(email: string, password = passwordOf(email)) {
    return auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
  }

  async function cookieOf(email: string) {
    const response = await signIn(email);
    expect(response.status, email).toBe(200);
    return response.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ");
  }

  async function sessionOf(email: string): Promise<Session | null> {
    return auth.api.getSession({ headers: new Headers({ cookie: await cookieOf(email) }) });
  }

  const deps = () => {
    const { t } = world.get();
    return {
      db: t.appDb,
      withTenant: <T>(id: string, fn: Parameters<typeof withTenantOn<T>>[2]) => withTenantOn(t.appDb, id, fn),
    };
  };

  /** What resolveViewer refused with: its status and body. */
  const refusal = async (session: Session | null, why: string) => {
    const outcome = await resolveViewer(session, deps()).then(
      (viewer) => ({ viewer }),
      (error: unknown) => ({ error }),
    );
    expect("viewer" in outcome ? `a viewer for ${outcome.viewer.username}` : "a refusal", why).toBe("a refusal");
    const { error } = outcome as { error: unknown };
    expect(error, "throw a Response (TanStack Start sends it as is)").toBeInstanceOf(Response);
    const response = error as Response;
    return { status: response.status, body: await response.json() };
  };

  /** resolveViewer's viewer, or a failed test that says what it refused with instead. */
  const admitted = async (session: Session | null, why: string) => {
    try {
      return await resolveViewer(session, deps());
    } catch (error) {
      const said = error instanceof Response ? `${error.status} ${await error.text()}` : String(error);
      expect.fail(`${why}; got ${said}`);
    }
  };

  beforeAll(async () => {
    const { t } = world.get();
    // The auth modules read these at import, so they bind to this test's database.
    Object.assign(process.env, {
      DATABASE_URL: t.appUrl,
      AC_ENV: "test",
      BETTER_AUTH_SECRET: DEV_SECRETS.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: "http://localhost:3000",
    });
    ({ auth } = await import("@/lib/auth"));
    const { db } = await import("@/db/client");
    closeAuthDb = () => db.$client.end();
    const { seedWorld } = await import("@/db/seed");
    await seedWorld(directory);
  }, 120_000);

  afterAll(async () => {
    await closeAuthDb?.();
  });

  it("turns Leo's session into Leo, in Kestrel", async () => {
    const w = world.get();
    expect(await resolveViewer(await sessionOf("leo.martin@kestrelpay.example"), deps())).toEqual({
      userId: w.user("leo.martin"),
      email: "leo.martin@kestrelpay.example",
      username: "leo.martin",
      name: "Leo Martin",
      tenant: { id: w.tenants.kestrel, slug: "kestrel" },
    });
  });

  it("puts Harbour's users in Harbour", async () => {
    const viewer = await resolveViewer(await sessionOf("nina.osei@harbourhealth.example"), deps());
    expect(viewer.tenant).toEqual({ id: world.get().tenants.harbour, slug: "harbour" });
    expect(viewer.username).toBe("nina.osei");
  });

  it("answers 401 without a session", async () => {
    expect(await refusal(null, "no session"), "no session is 401 unauthorized: nobody is signed in").toEqual({
      status: 401,
      body: { error: "unauthorized" },
    });
  });

  it("takes the tenant from the membership, even when the session's cached organization says Harbour", async () => {
    const { t, tenants } = world.get();
    const cookie = await cookieOf("leo.martin@kestrelpay.example");
    const token = decodeURIComponent(cookie.split("=")[1]).split(".")[0];
    await t.sql`UPDATE session SET active_organization_id = ${tenants.harbour} WHERE token = ${token}`;
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.session.activeOrganizationId).toBe(tenants.harbour);
    expect(
      (await resolveViewer(session, deps())).tenant.slug,
      "activeOrganizationId is a cache the plugin rewrites: read the user's member row",
    ).toBe("kestrel");

    await t.sql`UPDATE session SET active_organization_id = NULL WHERE token = ${token}`;
    const nulled = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect((await resolveViewer(nulled, deps())).tenant.slug, "a refused set-active nulls the cache").toBe("kestrel");
  });

  it("answers 403 for a user who belongs to no organization", async () => {
    await auth.api.createUser({
      body: { email: "contractor@kestrelpay.example", password: "dev-password", name: "Contractor" },
    });
    const session = await sessionOf("contractor@kestrelpay.example");
    expect(await refusal(session, "a user with no member row")).toEqual({ status: 403, body: { error: "no_tenant" } });
  });

  it("answers 403 for a user the directory has disabled, though their cookie still works", async () => {
    const { t } = world.get();
    const sam = world.get().user("sam.patel");
    const session = await sessionOf("sam.patel@kestrelpay.example");
    expect((await resolveViewer(session, deps())).username).toBe("sam.patel");
    await t.sql`UPDATE principals SET enabled = false WHERE id = ${sam}`;
    try {
      const again = await auth.api.getSession({
        headers: new Headers({ cookie: await cookieOf("sam.patel@kestrelpay.example") }),
      });
      expect(again, "better-auth still accepts the cookie: only your check stops him").not.toBeNull();
      const why =
        "his principal is disabled. Read it inside deps.withTenant: outside it RLS hides every row, and disabled looks like unsynced";
      expect(await refusal(again, why)).toEqual({ status: 403, body: { error: "disabled" } });
    } finally {
      await t.sql`UPDATE principals SET enabled = true WHERE id = ${sam}`;
    }
  });

  it("lets in a member the directory hasn't synced yet", async () => {
    const { tenants } = world.get();
    const { user } = await auth.api.createUser({
      body: { email: "new.starter@kestrelpay.example", password: "dev-password", name: "New Starter" },
    });
    await auth.api.addMember({ body: { userId: user.id, organizationId: tenants.kestrel, role: "member" } });
    const viewer = await admitted(
      await sessionOf("new.starter@kestrelpay.example"),
      "no principal yet isn't disabled: let them in; they can retrieve nothing until sync",
    );
    expect(viewer).toMatchObject({
      username: "new.starter",
      tenant: { slug: "kestrel" },
    });
  });

  it("follows Leo from his password to his viewer: a 7-day httpOnly cookie, his one membership, Kestrel", async () => {
    const { t, tenants } = world.get();
    const response = await signIn("leo.martin@kestrelpay.example");
    const [setCookie] = response.headers.getSetCookie();
    expect(setCookie).toMatch(/^better-auth\.session_token=[^;]+; Max-Age=604800; Path=\/; HttpOnly; SameSite=Lax$/);

    const cookie = setCookie.split(";")[0];
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.session.activeOrganizationId, "the session-create hook caches his organization").toBe(
      tenants.kestrel,
    );
    const members = await t.sql`SELECT organization_id FROM member WHERE user_id = ${world.get().user("leo.martin")}`;
    expect(members).toEqual([{ organization_id: tenants.kestrel }]);
    expect((await resolveViewer(session, deps())).tenant).toEqual({ id: tenants.kestrel, slug: "kestrel" });

    const peter = await signIn("peter.hall@kestrelpay.example");
    expect([peter.status, (await peter.json()).code], "disabled in world.yaml, so banned at sign-in").toEqual([
      403,
      "BANNED_USER",
    ]);
  });
});
