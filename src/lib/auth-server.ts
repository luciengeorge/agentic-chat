import { getRequestHeaders } from "@tanstack/react-start/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { member, organization } from "@/db/schema";
import { auth } from "@/lib/auth";

export interface Viewer {
  userId: string;
  email: string;
  username: string;
  name: string;
  tenant: { id: string; slug: string };
}

/** The signed-in user and their tenant, for server functions and server routes. Throws a 401
 * Response without a session, and a 403 one for a user who belongs to no organization; TanStack
 * Start sends a thrown Response as is. */
export async function getViewer(headers: Headers = getRequestHeaders()): Promise<Viewer> {
  const session = await auth.api.getSession({ headers });
  if (!session) throw Response.json({ error: "unauthorized" }, { status: 401 });

  // The tenant is the user's one membership. The session's activeOrganizationId is the organization plugin's
  // cache, and the plugin rewrites it: a refused set-active nulls it before it throws. So it decides nothing here.
  const [tenant] = await db
    .select({ id: organization.id, slug: organization.slug })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, session.user.id));
  if (!tenant) throw Response.json({ error: "no_tenant" }, { status: 403 });

  const { id, email, name } = session.user;
  // Emails are <username>@<tenant domain>, from the world's directory.
  return { userId: id, email, username: email.split("@")[0], name, tenant };
}
