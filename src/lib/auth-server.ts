import { getRequestHeaders } from "@tanstack/react-start/server";

import { resolveViewer, type Viewer } from "#learn/boundary/viewer";
import { db } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { auth } from "@/lib/auth";

export type { Viewer };

/** The signed-in user and their tenant, for server functions and server routes: the session from the request's
 * cookie, turned into a viewer by `resolveViewer` (section 11.1), which throws the 401 or 403. */
export async function getViewer(headers: Headers = getRequestHeaders()): Promise<Viewer> {
  return resolveViewer(await auth.api.getSession({ headers }), { db, withTenant });
}
