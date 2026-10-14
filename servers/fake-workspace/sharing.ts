/**
 * Graph's `POST /v1.0/drives/{drive}/items/{item}/invite`: grants users or groups a role on an item. The grant
 * becomes one of the item's own, so it shows in its permissions, in delta (as a sharing change) and in a change
 * notification, and ACL sync picks it up like any other.
 *
 * It acts for a user, as a delegated token would: `X-Acting-User` names them (a real token's subject). Someone who
 * can't read the item can't share it, whatever the app in front of the service decided.
 */
import type { Hono } from "hono";

import { z } from "zod";

import type { Runtime } from "./app";
import type { Grant } from "./site";

import { iso } from "./clock";
import { permission } from "./drive";
import { GraphError, badRequest } from "./errors";
import { readBody, subscriber } from "./http";
import { userCanRead } from "./mail";

export const ACTING_USER_HEADER = "x-acting-user";

export interface InviteRecord {
  readonly site: string;
  readonly itemId: string;
  readonly by: string;
  readonly recipients: readonly string[];
  readonly role: "read" | "write";
  /** Recipients who didn't hold the role before. */
  readonly added: readonly string[];
  readonly idempotencyKey: string | null;
  readonly at: string;
}

/** Invites that went through, oldest first, for `GET /_control/invites`. */
export class InviteLog {
  readonly done: InviteRecord[] = [];

  clear(): void {
    this.done.length = 0;
  }
}

const InviteSchema = z.object({
  recipients: z
    .array(z.object({ objectId: z.string() }))
    .min(1)
    .max(20),
  roles: z.tuple([z.enum(["read", "write"])]),
  requireSignIn: z.boolean().default(true),
  sendInvitation: z.boolean().default(false),
  message: z.string().max(2000).optional(),
});

export function sharingRoutes(app: Hono, rt: Runtime): void {
  app.post("/v1.0/drives/:drive/items/:itemId/invite", async (c) => {
    const body = await readBody(c, InviteSchema);
    const siteName = await subscriber(c, rt);
    if (c.req.param("drive") !== siteName)
      throw new GraphError(403, "accessDenied", "The token can't open this drive.");
    const site = rt.workspace.sites.get(siteName)!;
    const directory = rt.workspace.directories.get(siteName)!;
    const [role] = body.roles;
    const actingUser = c.req.header(ACTING_USER_HEADER) ?? "";

    return rt.idempotency.run(c, siteName, { ...body, actingUser }, () => {
      const item = site.get(c.req.param("itemId"));
      // The second line of defence: the agent checked the sharer, and the service checks them again.
      if (!actingUser)
        throw new GraphError(401, "unauthenticated", `Sharing needs the acting user (${ACTING_USER_HEADER}).`);
      if (!userCanRead(site, directory, actingUser, item)) {
        throw new GraphError(403, "accessDenied", "The acting user can't read this item, so can't share it.");
      }
      const grants: Grant[] = body.recipients.map(({ objectId }) => {
        const user = directory.users.find((u) => u.id === objectId);
        if (user) {
          if (!user.enabled) throw badRequest(`Recipient ${objectId}: the account is disabled.`);
          return { principal_type: "user", principal_id: user.id, principal_name: user.name, role };
        }
        const group = directory.groups.find((g) => g.id === objectId);
        if (group) return { principal_type: "group", principal_id: group.id, principal_name: group.path, role };
        throw badRequest(`Recipient ${objectId}: not a user or group of this site.`);
      });

      // A principal that already holds the role, or a stronger one, needs nothing new.
      const held = site.effective(item);
      const holds = (g: Grant) =>
        held.some(
          ({ grant }) => grant.principal_id === g.principal_id && (grant.role === "write" || grant.role === g.role),
        );
      const added = grants.filter((g) => !holds(g));
      if (added.length) {
        const ids = new Set(added.map((g) => g.principal_id));
        site.setSharing(item.id, {
          inherit: item.sharing.inherit,
          grants: [...item.sharing.grants.filter((g) => !ids.has(g.principal_id)), ...added],
        });
        rt.notifier.changed(site.name, site.seq);
      }

      rt.invites.done.push({
        site: siteName,
        itemId: item.id,
        by: actingUser,
        recipients: grants.map((g) => g.principal_id),
        role,
        added: added.map((g) => g.principal_id),
        idempotencyKey: c.req.header("idempotency-key") ?? null,
        at: iso(rt.clock.now()),
      });

      const ids = new Set(grants.map((g) => g.principal_id));
      const value = site
        .effective(item)
        .filter(({ grant }) => ids.has(grant.principal_id))
        .map((effective) => permission(site, item, effective));
      return { status: 200, body: { value } };
    });
  });

  /** Every invite since the last reset, oldest first. Behind the control API's checks. */
  app.get("/_control/invites", (c) => c.json({ value: rt.invites.done }));
}
