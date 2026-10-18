/**
 * The server boundary (section 11.2). Every server function and server route that acts for a user runs behind this
 * one middleware: it loads the session and the viewer's tenant (from their membership, never from the request), or
 * answers 401 or 403 before the handler runs. Handlers read `context.viewer`.
 */
import { createMiddleware } from "@tanstack/react-start";

import type { Viewer as RetrievalViewer } from "#learn/retrieve/types";

import { getViewer, type Viewer } from "@/lib/auth-server";

/** The viewer for a request, or the 401 or 403 Response `getViewer` throws. */
export async function viewerFrom(
  request: Request,
  load: (headers: Headers) => Promise<Viewer>,
): Promise<Viewer | Response> {
  try {
    return await load(request.headers);
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

/**
 * `getViewer` is referenced only inside `.server()`, which the client build drops, so the auth code (and its
 * database driver) never reaches the browser.
 */
export const viewerMiddleware = createMiddleware().server(async ({ next, request }) => {
  const viewer = await viewerFrom(request, getViewer);
  if (viewer instanceof Response) return viewer;
  return next({ context: { viewer } });
});

/** The two ids retrieval and the database need. */
export const scopeOf = (viewer: Viewer): RetrievalViewer => ({ tenantId: viewer.tenant.id, userId: viewer.userId });
