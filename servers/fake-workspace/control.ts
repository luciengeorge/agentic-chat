/**
 * The control API (`/_control/...`): dev only, no bearer token. Tests and the lab panel use it to
 * reset state, inject faults, pin the clock, change items and watch webhook deliveries.
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
import { readBody } from "./http";

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

export function controlRoutes(app: Hono, rt: Runtime): void {
  app.use("/_control/*", async (_, next) => {
    if (rt.env !== "dev") throw new GraphError(403, "accessDenied", "The control API only runs when AC_ENV=dev.");
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

  /** Reload the manifest; drop faults, subscriptions, deliveries, the change log and the clock. */
  app.post("/_control/reset", async (c) => {
    await rt.notifier.reset();
    rt.faults.clear();
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
    const site = controlSite(c);
    const body = await readBody(c, NewFileSchema);
    const item = site.createFile(body.parent_id, body.name, body.content_base64, body.mime_type, stamp(rt.clock));
    changed(site);
    return c.json(driveItem(site, item), 201);
  });

  app.put(`${items}/:itemId/content`, async (c) => {
    const site = controlSite(c);
    const body = await readBody(c, UploadSchema);
    const item = site.upload(c.req.param("itemId"), body.content_base64, body.mime_type, stamp(rt.clock));
    changed(site);
    return c.json(driveItem(site, item));
  });

  app.post(`${items}/:itemId/move`, async (c) => {
    const site = controlSite(c);
    const body = await readBody(c, MoveSchema);
    const item = site.move(c.req.param("itemId"), body.parent_id, body.name, stamp(rt.clock));
    changed(site);
    return c.json(driveItem(site, item));
  });

  app.post(`${items}/:itemId/rename`, async (c) => {
    const site = controlSite(c);
    const { name } = await readBody(c, RenameSchema);
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

  app.put(`${items}/:itemId/sharing`, async (c) => {
    const site = controlSite(c);
    const sharing = await readBody(c, SharingSchema);
    const item = site.setSharing(c.req.param("itemId"), sharing);
    changed(site);
    return c.json(driveItem(site, item));
  });
}
