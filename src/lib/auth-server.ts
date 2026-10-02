import { getRequestHeaders } from "@tanstack/react-start/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { organization } from "@/db/schema";
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

  const tenantId = session.session.activeOrganizationId;
  const [tenant] = tenantId
    ? await db
        .select({ id: organization.id, slug: organization.slug })
        .from(organization)
        .where(eq(organization.id, tenantId))
    : [];
  if (!tenant) throw Response.json({ error: "no_tenant" }, { status: 403 });

  const { id, email, name } = session.user;
  // Emails are <username>@<tenant domain>, from the world's directory.
  return { userId: id, email, username: email.split("@")[0], name, tenant };
}
