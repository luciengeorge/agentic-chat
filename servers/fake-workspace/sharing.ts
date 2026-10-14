/**
 * Graph's `POST /v1.0/drives/{drive}/items/{item}/invite`: grants users or groups a role on an item. The grant
 * becomes one of the item's own, so it shows in its permissions, in delta (as a sharing change) and in a change
 * notification, and ACL sync picks it up like any other.
 */
import type { Hono } from "hono";

import { z } from "zod";

import type { Runtime } from "./app";
import type { Grant } from "./site";

import { permission } from "./drive";
import { GraphError, badRequest } from "./errors";
import { readBody, subscriber } from "./http";

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

    return rt.idempotency.run(c, siteName, body, () => {
      const item = site.get(c.req.param("itemId"));
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

      const ids = new Set(grants.map((g) => g.principal_id));
      const value = site
        .effective(item)
        .filter(({ grant }) => ids.has(grant.principal_id))
        .map((effective) => permission(site, item, effective));
      return { status: 200, body: { value } };
    });
  });
}
