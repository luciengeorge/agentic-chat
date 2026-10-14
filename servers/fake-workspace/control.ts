/**
 * The control API (`/_control/...`): dev only, no bearer token. Tests and the lab panel use it to
 * reset state, inject faults, pin the clock, change items and watch webhook deliveries.
 *
 * Every request carries the `x-workspace-control` header. A web page can't send a custom header to
 * another origin without a CORS preflight, which this server never answers, so a page open in the
 * browser can't post a form here. A request from a page that isn't on this machine is refused too.
 */
import type { Context, Hono } from "hono";

import { z } from "zod";

import type { Runtime } from "./app";
import type { Site } from "./site";

import { stamp, iso } from "./clock";
import { CorpusError, SharingSchema, awareDatetime } from "./corpus";
import { deliveryJson } from "./delivery";
import { driveItem } from "./drive";
import { GraphError, notFound, notReady } from "./errors";
import { FaultSpecSchema } from "./faults";
import { parseBody, readBody, readJson } from "./http";

const base64 = z.base64().transform((text) => new Uint8Array(Buffer.from(text, "base64")));

const NewFileSchema = z.object({
  parent_id: z.string(),
  name: z.string(),
  content_base64: base64,
  mime_type: z.string(),
});
const UploadSchema = z.object({ content_base64: base64, mime_type: z.string().nullish().default(null) });
const MoveSchema = z.object({ parent_id: z.string(), name: z.string().nullish().default(null) });
const RenameSchema = z.object({ name: z.string() });
const ClockSchema = z.object({ now: awareDatetime.nullable() });
const MemberSchema = z.object({ member_id: z.string() });

export const CONTROL_HEADER = "x-workspace-control";
/** What `FAKE_WORKSPACE_CONTROL_TOKEN` defaults to, as in `.env.example`. Public, like the dev bearer tokens. */
export const DEV_CONTROL_TOKEN = "dev-workspace-control";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function fromThisMachine(origin: string): boolean {
  const hostname = URL.parse(origin)?.hostname;
  return hostname !== undefined && LOOPBACK.has(hostname);
}

export function controlRoutes(app: Hono, rt: Runtime): void {
  app.use("/_control/*", async (c, next) => {
    if (rt.env !== "dev") throw new GraphError(403, "accessDenied", "The control API only runs when AC_ENV=dev.");
    const origin = c.req.header("origin");
    if (origin !== undefined && !fromThisMachine(origin)) {
      throw new GraphError(403, "accessDenied", `The control API refuses requests from ${origin}.`);
    }
    if (c.req.header(CONTROL_HEADER) !== rt.controlToken) {
      const message = `The control API needs the ${CONTROL_HEADER} header, set to FAKE_WORKSPACE_CONTROL_TOKEN.`;
      throw new GraphError(403, "accessDenied", message);
    }
    await next();
  });

  function controlSite(c: Context): Site {
    if (!rt.workspace.loaded) throw notReady();
    const name = c.req.param("site")!;
    const site = rt.workspace.sites.get(name);
    if (!site) throw notFound(`No site '${name}'.`);
    return site;
  }

  /** Every mutation lands in delta and notifies the site's subscriptions. */
  function changed(site: Site): void {
    rt.notifier.changed(site.name, site.seq);
  }

  /** Reload the manifest; drop faults, subscriptions, deliveries, the change log, the clock, sent mail and
   * idempotency keys. */
  app.post("/_control/reset", async (c) => {
    await rt.notifier.reset();
    rt.faults.clear();
    rt.mailroom.clear();
    rt.idempotency.clear();
    rt.clock.pinned = null;
    try {
      rt.workspace.reset();
    } catch (error) {
      if (error instanceof CorpusError) throw notReady(error.message);
      throw error;
    }
    const sites = Object.fromEntries([...rt.workspace.sites].map(([name, site]) => [name, site.items.size]));
    return c.json({ corpus_loaded: true, sites });
  });

  app.post("/_control/faults", async (c) => {
    const spec = await readBody(c, FaultSpecSchema);
    rt.faults.add(spec);
    return c.json(spec, 201);
  });

  app.delete("/_control/faults", (c) => {
    rt.faults.clear();
    return c.body(null, 204);
  });

  app.post("/_control/clock", async (c) => {
    const { now } = await readBody(c, ClockSchema);
    rt.clock.pinned = now;
    return c.json({ now: iso(rt.clock.now()), pinned: now !== null });
  });

  app.get("/_control/deliveries", (c) => c.json({ value: rt.notifier.deliveries.map(deliveryJson) }));

  /** Wait for every pending delivery, retries included, then return the log. */
  app.post("/_control/flush", async (c) => {
    await rt.notifier.flush();
    return c.json({ value: rt.notifier.deliveries.map(deliveryJson) });
  });

  const items = "/_control/sites/:site/items";

  app.post(items, async (c) => {
    const data = await readJson(c);
    const site = controlSite(c);
    const body = parseBody(NewFileSchema, data);
    const item = site.createFile(body.parent_id, body.name, body.content_base64, body.mime_type, stamp(rt.clock));
    changed(site);
    return c.json(driveItem(site, item), 201);
  });

  app.put(`${items}/:itemId/content`, async (c) => {
    const data = await readJson(c);
    const site = controlSite(c);
    const body = parseBody(UploadSchema, data);
    const item = site.upload(c.req.param("itemId"), body.content_base64, body.mime_type, stamp(rt.clock));
    changed(site);
    return c.json(driveItem(site, item));
  });

  app.post(`${items}/:itemId/move`, async (c) => {
    const data = await readJson(c);
    const site = controlSite(c);
    const body = parseBody(MoveSchema, data);
    const item = site.move(c.req.param("itemId"), body.parent_id, body.name, stamp(rt.clock));
    changed(site);
    return c.json(driveItem(site, item));
  });

  app.post(`${items}/:itemId/rename`, async (c) => {
    const data = await readJson(c);
    const site = controlSite(c);
    const { name } = parseBody(RenameSchema, data);
    const item = site.rename(c.req.param("itemId"), name, stamp(rt.clock));
    changed(site);
    return c.json(driveItem(site, item));
  });

  app.delete(`${items}/:itemId`, (c) => {
    const site = controlSite(c);
    site.delete(c.req.param("itemId"));
    changed(site);
    return c.body(null, 204);
  });

  /** Directory membership, in memory until the next reset. Users only: subgroups follow their paths. */
  const groupMembers = "/_control/sites/:site/groups/:groupId/members";

  app.post(groupMembers, async (c) => {
    const data = await readJson(c);
    const site = controlSite(c);
    const { member_id } = parseBody(MemberSchema, data);
    const directory = rt.workspace.directories.get(site.name)!;
    directory.setMembership(directory.group(c.req.param("groupId")), member_id, true);
    return c.body(null, 201);
  });

  app.delete(`${groupMembers}/:memberId`, (c) => {
    const site = controlSite(c);
    const directory = rt.workspace.directories.get(site.name)!;
    directory.setMembership(directory.group(c.req.param("groupId")), c.req.param("memberId"), false);
    return c.body(null, 204);
  });

  app.put(`${items}/:itemId/sharing`, async (c) => {
    const data = await readJson(c);
    const site = controlSite(c);
    const sharing = parseBody(SharingSchema, data);
    const item = site.setSharing(c.req.param("itemId"), sharing);
    changed(site);
    return c.json(driveItem(site, item));
  });
}
