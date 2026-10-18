import { createMiddleware } from "@tanstack/react-start";

import type { Viewer } from "@/lib/auth-server";

import { viewerMiddleware as viewerOnly } from "#learn/boundary/middleware";

/** The boundary lives in `#learn/boundary/middleware` (section 11.2); every importer keeps importing it from here. */
export { scopeOf, viewerFrom } from "#learn/boundary/middleware";

/** Dev only: notes each request that went through the boundary for `/labs/boundary`. It runs outside the viewer
 * middleware, so a 401 or 403 it answers is noted too. */
const requestLog = createMiddleware().server(async ({ next, request, pathname, serverFnMeta }) => {
  const started = performance.now();
  const result = await next();
  const { recordRequest } = await import("@/components/labs/boundary-log");
  await recordRequest({
    request,
    pathname,
    serverFn: serverFnMeta ? { name: serverFnMeta.name, filename: serverFnMeta.filename } : undefined,
    viewer: (result.context as unknown as { viewer?: Viewer } | undefined)?.viewer ?? null,
    status: result.response?.status ?? 200,
    ms: performance.now() - started,
  });
  return result;
});

/**
 * The server boundary: every server function and server route that acts for a user names this one middleware.
 * Handlers read `context.viewer`.
 */
export const viewerMiddleware = createMiddleware()
  .middleware([requestLog, viewerOnly])
  .server(({ next }) => next());
