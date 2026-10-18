// 👨‍💼 Kestrel and Harbour Health share one app. Leo Martin signs in at Kestrel; Nina Osei at Harbour. Every request
//    either of them makes has to be answered for the right person, in the right tenant, and refused the moment the
//    directory says they've left. This file turns a better-auth session into that answer.

/**
 * Who is asking (section 11.1). better-auth keeps the session in an httpOnly cookie and looks it up on every request;
 * this turns that session into the viewer every server function and route acts for: the user, and the one
 * organization they belong to, which is their tenant.
 */
import type { Db } from "@/db/create";
import type { Tx } from "@/db/tenant";

export interface Viewer {
  userId: string;
  email: string;
  username: string;
  name: string;
  tenant: { id: string; slug: string };
}

/** The parts of better-auth's `getSession` answer this reads. */
export interface Session {
  user: { id: string; email: string; name: string };
  session: { activeOrganizationId?: string | null };
}

export interface ViewerDeps {
  /** The app's pool, for the auth tables, which have no tenant. */
  db: Db;
  /** A transaction scoped to one tenant, for the tenant tables (RLS). */
  withTenant: <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

/**
 * The viewer for a session. Throws a 401 Response without a session, and a 403 one for a user who belongs to no
 * organization or whom the directory has disabled; TanStack Start sends a thrown Response as is. A user the
 * directory hasn't synced yet gets through: with no principal they can store nothing and retrieve nothing.
 */
export async function resolveViewer(session: Session | null, deps: ViewerDeps): Promise<Viewer> {
  // 🐨 No session: throw a 401 Response, `{ error: "unauthorized" }`.
  // 🐨 Find the user's tenant from their membership: the `member` row for the session's user id, joined to its
  //    `organization` for the id and slug. On `deps.db`: the auth tables have no tenant. No membership: throw a 403,
  //    `{ error: "no_tenant" }`.
  // 🐨 Then, inside that tenant (`deps.withTenant`), read the user's principal (`principals`, by the user's id and
  //    kind "user"). If there is one and it isn't enabled, throw a 403, `{ error: "disabled" }`. If there is none, let
  //    them through: the directory hasn't synced them yet.
  // 🐨 Return the viewer: the session user's id, email and name, the username (the part of the email before the
  //    @), and the tenant.
  // 🐨 The classic mistake: taking the tenant from `session.session.activeOrganizationId`. It looks like the answer
  //    and it isn't one. Read the membership.
  //
  // 💰 Add `import { and, eq } from "drizzle-orm"` and `import { member, organization, principals } from
  //    "@/db/schema"`. `db.select({ id: organization.id, slug: organization.slug }).from(member).innerJoin(organization,
  //    eq(organization.id, member.organizationId)).where(eq(member.userId, ...))` gives a list; `const [row] = ...`
  //    takes the first. `throw Response.json({ error: "..." }, { status: 403 })`.
  //
  // 🦉 What better-auth gives you. Leo signs in with his password; better-auth writes a `session` row with a random
  //    token and sets a cookie holding that token, signed with `BETTER_AUTH_SECRET`. The cookie is httpOnly, so no
  //    script on the page can read it, and every request carries it. `auth.api.getSession` checks the signature,
  //    finds the row, checks it hasn't expired, and answers with the session and its user. That's all: who. Which
  //    tenant, and whether they're still allowed in, is this function's job.
  // 🦉 Why not activeOrganizationId. It's the organization plugin's cache of "the organization this session is
  //    working in", meant for apps where a user switches between many. It can be wrong: a refused
  //    `set-active-organization` call nulls it before it throws, which once locked Kestrel users out with 403s, and
  //    the plugin rewrites it on other calls. A user here belongs to exactly one organization (the database has a
  //    unique `member.user_id`, and a hook refuses a second), so the membership row is the truth and the cache
  //    decides nothing.
  // 🦉 Why read the principal inside the tenant. `principals` has row-level security (section 09.6). Outside
  //    `withTenant` the app role sees none of its rows, so a disabled user would look unsynced and walk straight in.
  //    The query reads fine and the check silently never fires: the worst kind of bug.
  // 🦉 Why check disabled here at all. A cookie lives 7 days. When the directory disables someone (they left, or
  //    their laptop was stolen), sync flips their principal to disabled, but their cookie still works. This check,
  //    on every request, is what ends their access within one sync.
  //
  // 📜 https://www.better-auth.com/docs/concepts/session-management
  // 📜 https://www.better-auth.com/docs/plugins/organization
  //
  // 🚨 The tests check Leo gets Kestrel and Nina Harbour, the 401 and the two 403s, a session whose cached
  //    organization says Harbour still gets Kestrel, a disabled user refused with a live cookie, an unsynced user let
  //    through, and Leo's real sign-in cookie.
  throw new Error(`resolveViewer(${session ? session.user.email : "no session"}, ${typeof deps}) isn't written yet`);
}
