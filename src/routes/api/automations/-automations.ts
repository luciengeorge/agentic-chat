import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Viewer } from "#learn/retrieve/types";
import type { Db } from "@/db/create";

import { NewAutomationSchema } from "#learn/automations/automation";
import { automations } from "@/db/schema";
import { withTenantOn } from "@/db/tenant";
import { createAutomation, type DueFire, listAutomations, setAutomationEnabled } from "@/lib/automations";
import { json, readBody } from "@/routes/api/runs/-runs";

export interface AutomationRoutesDeps {
  db: Db;
  /** Starts a fire's workflow (`startFire` in `src/workflows/automation-start.ts`). */
  fire: (fire: DueFire) => Promise<unknown>;
  now?: () => Date;
}

const notFound = () => json(404, { error: "not_found" });

/** `GET /api/automations`: the viewer's automations, each with its latest run. */
export async function handleListAutomations(viewer: Viewer, deps: AutomationRoutesDeps): Promise<Response> {
  const list = await withTenantOn(deps.db, viewer.tenantId, (tx) => listAutomations(tx, viewer));
  return json(200, { automations: list }, { "cache-control": "private, no-store" });
}

/** `POST /api/automations`: makes one, owned by the viewer, enabled. */
export async function handleCreateAutomation(request: Request, viewer: Viewer, deps: AutomationRoutesDeps) {
  const body = await readBody(request, NewAutomationSchema);
  if (body instanceof Response) return body;
  const id = await withTenantOn(deps.db, viewer.tenantId, (tx) => createAutomation(tx, viewer, body));
  return json(201, { id });
}

const PatchSchema = z.object({ enabled: z.boolean() });

/** `PATCH /api/automations/:id` with `{ enabled }`. Someone else's answers 404. */
export async function handleSetEnabled(request: Request, viewer: Viewer, id: string, deps: AutomationRoutesDeps) {
  if (!z.uuid().safeParse(id).success) return notFound();
  const body = await readBody(request, PatchSchema);
  if (body instanceof Response) return body;
  const done = await withTenantOn(deps.db, viewer.tenantId, (tx) => setAutomationEnabled(tx, viewer, id, body.enabled));
  return done ? json(200, { id, enabled: body.enabled }) : notFound();
}

/** `POST /api/automations/:id/run`: fires it now, whatever its trigger, as a one-off. */
export async function handleRunNow(viewer: Viewer, id: string, deps: AutomationRoutesDeps): Promise<Response> {
  if (!z.uuid().safeParse(id).success) return notFound();
  const [row] = await withTenantOn(deps.db, viewer.tenantId, (tx) =>
    tx
      .select({ ownerId: automations.ownerId, enabled: automations.enabled })
      .from(automations)
      .where(eq(automations.id, id)),
  );
  if (!row || row.ownerId !== viewer.userId) return notFound();
  if (!row.enabled) return json(409, { error: "disabled" });
  const firedAt = (deps.now ?? (() => new Date()))();
  const fireKey = `manual:${crypto.randomUUID()}`;
  await deps.fire({ tenantId: viewer.tenantId, automationId: id, fireKey, firedAt });
  return json(202, { id, fireKey });
}
