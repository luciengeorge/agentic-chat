/** `/v1.0/subscriptions`: create (with the validation handshake), renew and delete. */
import type { Hono } from "hono";

import type { Runtime } from "./app";

import { SubscriptionRenewalSchema, SubscriptionRequestSchema, subscriptionJson } from "./delivery";
import { parseBody, readJson, subscriber } from "./http";

export function subscriptionRoutes(app: Hono, rt: Runtime): void {
  app.post("/v1.0/subscriptions", async (c) => {
    const data = await readJson(c);
    const site = await subscriber(c, rt);
    const request = parseBody(SubscriptionRequestSchema, data);
    return c.json(subscriptionJson(await rt.notifier.subscribe(site, request)), 201);
  });

  app.patch("/v1.0/subscriptions/:id", async (c) => {
    const data = await readJson(c);
    const site = await subscriber(c, rt);
    const { expirationDateTime } = parseBody(SubscriptionRenewalSchema, data);
    return c.json(subscriptionJson(rt.notifier.renew(site, c.req.param("id"), expirationDateTime)));
  });

  app.delete("/v1.0/subscriptions/:id", async (c) => {
    const site = await subscriber(c, rt);
    rt.notifier.remove(site, c.req.param("id"));
    return c.body(null, 204);
  });
}
