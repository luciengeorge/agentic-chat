/**
 * Who is asking (section 11.1). better-auth keeps the session in an httpOnly cookie and looks it up on every request;
 * this turns that session into the viewer every server function and route acts for: the user, and the one
 * organization they belong to, which is their tenant.
 */
import { and, eq } from "drizzle-orm";

import type { Db } from "@/db/create";
import type { Tx } from "@/db/tenant";

import { member, organization, principals } from "@/db/schema";

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
  if (!session) throw Response.json({ error: "unauthorized" }, { status: 401 });

  // The tenant is the user's one membership. The session's activeOrganizationId is the organization plugin's
  // cache, and the plugin rewrites it: a refused set-active nulls it before it throws. So it decides nothing here.
  const [tenant] = await deps.db
    .select({ id: organization.id, slug: organization.slug })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, session.user.id));
  if (!tenant) throw Response.json({ error: "no_tenant" }, { status: 403 });

  const [principal] = await deps.withTenant(tenant.id, (tx) =>
    tx
      .select({ enabled: principals.enabled })
      .from(principals)
      .where(and(eq(principals.id, session.user.id), eq(principals.kind, "user"))),
  );
  if (principal && !principal.enabled) throw Response.json({ error: "disabled" }, { status: 403 });

  const { id, email, name } = session.user;
  // Emails are <username>@<tenant domain>, from the world's directory.
  return { userId: id, email, username: email.split("@")[0], name, tenant };
}
