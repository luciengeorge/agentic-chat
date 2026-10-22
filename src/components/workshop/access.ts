import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { databaseDown } from "@/lib/database-status";

/**
 * The signed-in user, found with the reference code (`src/core`), never through a slot. Sections 09 and 11 put
 * the session lookup and the tenant transaction in the learner's hands, and a half-written step there must not lock
 * the learner out of the page that runs its tests.
 */
async function workshopViewer(headers: Headers) {
  const [{ resolveViewer }, { withTenantOn }, { auth }, { appDb }] = await Promise.all([
    import("@/core/boundary/viewer"),
    import("@/core/acl/tenant"),
    import("@/lib/auth"),
    import("@/db/pool"),
  ]);
  const db = appDb();
  return resolveViewer(await auth.api.getSession({ headers }), {
    db,
    withTenant: (tenantId, fn) => withTenantOn(db, tenantId, fn),
  });
}

async function devOnly(): Promise<string | null> {
  const { acEnv } = await import("@/lib/env");
  const env = acEnv();
  return env === "dev" ? null : env;
}

/** The repo `ex` works in: the dev server runs from its root. */
export const workshopRoot = () => process.cwd();

/** Every workshop server function and route: dev only, since they run `ex` on this machine, and signed in. */
export const workshopMiddleware = createMiddleware().server(async ({ next, request }) => {
  if (await devOnly()) return Response.json({ error: "The workshop only runs in dev." }, { status: 404 });
  let viewer;
  try {
    viewer = await workshopViewer(request.headers);
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  return next({ context: { viewer } });
});

export type WorkshopGate =
  | { state: "ok"; viewer: { name: string; email: string } }
  | { state: "signed-out" }
  | { state: "not-dev"; env: string }
  | { state: "db-down" };

/** For the route guard: whether this request may see the workshop, and if not, why. */
export const getWorkshopGate = createServerFn({ method: "GET" }).handler(async (): Promise<WorkshopGate> => {
  const env = await devOnly();
  if (env) return { state: "not-dev", env };
  try {
    const { name, email } = await workshopViewer(getRequestHeaders());
    return { state: "ok", viewer: { name, email } };
  } catch (error) {
    if (error instanceof Response && error.status === 401) return { state: "signed-out" };
    const [{ appDb }, { sql }] = await Promise.all([import("@/db/pool"), import("drizzle-orm")]);
    if (await databaseDown(() => appDb().execute(sql`select 1`))) return { state: "db-down" };
    throw error;
  }
});

/** Refuses a write a page on another origin could send: an Origin that isn't this server's. Scripts send none. */
export function crossOrigin(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    return Response.json({ error: "cross-origin request refused" }, { status: 403 });
  }
  return null;
}
