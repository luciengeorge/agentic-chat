// @vitest-environment node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { Clock } from "./clock";
import { type DeliveryPolicy, DEFAULT_POLICY, Notifier, SubscriptionRequestSchema } from "./delivery";
import { type Client, FAST, ManualClock, type Receiver, WAIT, setupFakeWorkspace, slowBody, until } from "./testing";

const NOW = "2026-10-01T12:00:00Z";
const EXPIRES = "2026-10-03T12:00:00Z";
const RESOURCE = "sites/kestrel/drive/root";
const HARBOUR = { Authorization: "Bearer dev-workspace-harbour" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A held handshake waits for the test. */
const PATIENT: DeliveryPolicy = { ...DEFAULT_POLICY, validationTimeoutS: 30 };

type Delivery = { id: number; subscription_id: string; change_seq: number; state: string; attempts: Attempt[] };
type Attempt = { at: string; status: number | null; error: string | null };

const fw = setupFakeWorkspace();

function request(receiver: Receiver, overrides: Record<string, unknown> = {}) {
  return {
    changeType: "updated",
    notificationUrl: receiver.url,
    resource: RESOURCE,
    expirationDateTime: EXPIRES,
    clientState: "kestrel-secret",
    ...overrides,
  };
}

async function subscribe(client: Client, receiver: Receiver) {
  await client.post("/_control/clock", { json: { now: NOW } });
  const response = await client.post("/v1.0/subscriptions", { json: request(receiver) });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json();
}

async function rename(client: Client, name: string): Promise<void> {
  const memo = fw.corpus.id("kestrel", "/Exec/Project Heron memo.pdf");
  const response = await client.post(`/_control/sites/kestrel/items/${memo}/rename`, { json: { name } });
  expect(response.status).toBe(200);
}

/** The delivery log once every pending delivery is done, retries included. */
async function deliveries(client: Client): Promise<Delivery[]> {
  const flushed = await client.post("/_control/flush");
  expect(flushed.status).toBe(200);
  const log = (await (await client.get("/_control/deliveries")).json()).value;
  expect((await flushed.json()).value).toEqual(log);
  return log;
}

/** The delivery log, once `count` deliveries are delivered or waiting to retry. */
async function settled(client: Client, count: number): Promise<Delivery[]> {
  return vi.waitFor(async () => {
    const log: Delivery[] = (await (await client.get("/_control/deliveries")).json()).value;
    expect(log.filter((d) => d.attempts.length)).toHaveLength(count);
    return log;
  }, WAIT);
}

describe("the handshake", () => {
  it("echoes the decoded token", async () => {
    const receiver = await fw.receiver();
    const { id, ...subscription } = await subscribe(fw.client(), receiver);
    expect(id).toMatch(UUID);
    expect(subscription).toStrictEqual({
      changeType: "updated",
      notificationUrl: receiver.url,
      resource: RESOURCE,
      expirationDateTime: EXPIRES,
      clientState: "kestrel-secret",
    });
    // Graph's tokens carry spaces and colons, so the endpoint must URL-decode them.
    expect(receiver.tokens).toHaveLength(1);
    expect(receiver.tokens[0]).toMatch(/^Validation: /);
  });

  it.each([
    ["wrong", "must exactly match"],
    ["empty", "must exactly match"],
    ["html", "must be text/plain"],
    // Never answered while the subscription waits, so only the timeout (0.5s here) ends it.
    ["held", "timed out"],
  ] as const)("a failed one (%s) creates nothing", async (validation, problem) => {
    const client = fw.client();
    await client.post("/_control/clock", { json: { now: NOW } });
    const receiver = await fw.receiver();
    receiver.validation = validation;
    const response = await client.post("/v1.0/subscriptions", { json: request(receiver) });
    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error.code).toBe("InvalidRequest");
    expect(error.message).toContain("validation");
    expect(error.message).toContain(problem);
    expect(receiver.tokens).toHaveLength(1);
    await rename(client, "Heron.pdf");
    expect(await deliveries(client)).toEqual([]);
  });

  it("fails on a redirect, which Graph doesn't follow", async () => {
    const receiver = await fw.receiver();
    const target = await fw.receiver();
    receiver.redirectTo = new URL(target.url).origin;
    const client = fw.client();
    await client.post("/_control/clock", { json: { now: NOW } });
    const response = await client.post("/v1.0/subscriptions", { json: request(receiver) });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("must respond with 200 OK");
    expect(target.tokens).toEqual([]);
  });

  it("fails on an unreachable endpoint", async () => {
    const body = request(await fw.receiver(), { notificationUrl: "http://127.0.0.1:9/hooks" });
    const client = fw.client();
    await client.post("/_control/clock", { json: { now: NOW } });
    const response = await client.post("/v1.0/subscriptions", { json: body });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("validation");
  });
});

describe("a subscription request", () => {
  it.each([
    [{ changeType: "created" }, 400],
    [{ resource: "sites/kestrel/drive/items/abc" }, 400],
    [{ resource: "sites/harbour/drive/root" }, 403],
    [{ expirationDateTime: "2026-09-30T12:00:00Z" }, 400],
    [{ expirationDateTime: "2026-11-30T12:00:00Z" }, 400],
    [{ expirationDateTime: "2026-10-03T12:00:00" }, 400],
    [{ notificationUrl: "ftp://example.com/hooks" }, 400],
    [{ clientState: undefined }, 400],
  ])("with %o is %i", async (overrides, status) => {
    const client = fw.client();
    const receiver = await fw.receiver();
    await client.post("/_control/clock", { json: { now: NOW } });
    const response = await client.post("/v1.0/subscriptions", { json: request(receiver, overrides) });
    expect(response.status, await response.clone().text()).toBe(status);
    expect(receiver.tokens).toEqual([]);
  });

  it("accepts a leading slash on the resource", async () => {
    const client = fw.client();
    await client.post("/_control/clock", { json: { now: NOW } });
    const body = request(await fw.receiver(), { resource: "/sites/kestrel/drive/root" });
    expect((await client.post("/v1.0/subscriptions", { json: body })).status).toBe(201);
  });

  it("needs a token", async () => {
    const response = await fw.client({ token: null }).post("/v1.0/subscriptions", {
      json: request(await fw.receiver()),
    });
    expect(response.status).toBe(401);
  });
});

describe("notifications", () => {
  it("arrive in order, with retries", async () => {
    const client = fw.client();
    const receiver = await fw.receiver();
    const subscription = await subscribe(client, receiver);
    receiver.statuses = [500, 503];
    for (const name of ["one.pdf", "two.pdf", "three.pdf"]) await rename(client, name);
    const log = await deliveries(client);
    // The first notification is retried until it lands; the others wait their turn.
    expect(log.map((d) => d.attempts.map((a) => a.status))).toEqual([[500, 503, 202], [202], [202]]);
    expect(log.map((d) => d.state)).toEqual(["delivered", "delivered", "delivered"]);
    expect(log.map((d) => d.change_seq)).toEqual([1, 2, 3]);
    expect(new Set(log.map((d) => d.subscription_id))).toEqual(new Set([subscription.id]));
    expect(log.flatMap((d) => d.attempts).every((a) => a.at === NOW && a.error === null)).toBe(true);
    expect(receiver.notifications).toHaveLength(5);
    const { tenantId, ...notification } = receiver.notifications[0]!.value[0]!;
    expect(tenantId).toMatch(UUID);
    expect(notification).toStrictEqual({
      subscriptionId: subscription.id,
      clientState: "kestrel-secret",
      changeType: "updated",
      resource: RESOURCE,
      subscriptionExpirationDateTime: EXPIRES,
    });
    expect(new Set(receiver.notifications.map((n) => n.value[0]!.tenantId))).toEqual(new Set([tenantId]));
  });

  it("back off, doubling up to the cap", async () => {
    const clock = new ManualClock();
    const client = fw.client({ policy: { ...DEFAULT_POLICY, maxAttempts: 5, baseDelayS: 0.5, maxDelayS: 1.5 }, clock });
    const receiver = await fw.receiver();
    await subscribe(client, receiver);
    receiver.statuses = [500, 500, 500, 500];
    await rename(client, "one.pdf");
    const [delivery] = await deliveries(client);
    expect(delivery!.attempts.map((a) => a.status)).toEqual([500, 500, 500, 500, 202]);
    expect(clock.waits).toEqual([0.5, 1, 1.5, 1.5]);
  });

  it("give up after their attempts", async () => {
    const client = fw.client();
    const receiver = await fw.receiver();
    await subscribe(client, receiver);
    receiver.statuses = [500, 500, 500];
    await rename(client, "one.pdf");
    await rename(client, "two.pdf");
    const log = await deliveries(client);
    expect(log.map((d) => [d.state, d.attempts.length])).toEqual([
      ["failed", 3],
      ["delivered", 1],
    ]);
  });

  it("aren't redirected", async () => {
    const client = fw.client();
    const receiver = await fw.receiver();
    const target = await fw.receiver();
    await subscribe(client, receiver);
    receiver.redirectTo = new URL(target.url).origin;
    await rename(client, "one.pdf");
    const [delivery] = await deliveries(client);
    expect([delivery!.state, delivery!.attempts.map((a) => a.status)]).toEqual(["failed", [307, 307, 307]]);
    expect(target.notifications).toEqual([]);
  });

  it("to an unreachable endpoint are logged", async () => {
    const client = fw.client();
    const gone = await fw.receiver();
    await subscribe(client, gone);
    gone.dropConnections = true;
    await rename(client, "one.pdf");
    const [delivery] = await deliveries(client);
    expect(delivery!.state).toBe("failed");
    expect(delivery!.attempts.every((a) => a.status === null && a.error)).toBe(true);
  });

  it("go only to the changed site's subscriptions", async () => {
    const client = fw.client();
    const receiver = await fw.receiver();
    const kestrel = [await subscribe(client, receiver), await subscribe(client, receiver)];
    const body = request(receiver, { resource: "sites/harbour/drive/root" });
    expect((await client.post("/v1.0/subscriptions", { json: body, headers: HARBOUR })).ok).toBe(true);
    await rename(client, "one.pdf");
    const log = await deliveries(client);
    expect(log.map((d) => d.subscription_id).sort()).toEqual(kestrel.map((s) => s.id).sort());
  });

  it("to a failing endpoint don't hold up other subscriptions", async () => {
    const clock = new ManualClock({ gated: true });
    const client = fw.client({ clock });
    const receiver = await fw.receiver();
    receiver.statuses = [500, 500, 500, 500, 500];
    const failing = await subscribe(client, receiver);
    const healthy = await subscribe(client, await fw.receiver());
    await rename(client, "one.pdf");
    const log = new Map((await settled(client, 2)).map((d) => [d.subscription_id, d]));
    expect(log.get(healthy.id)!.state).toBe("delivered");
    expect(log.get(failing.id)!.state).toBe("pending");
  });
});

describe("retries in flight", () => {
  it("are cancelled by a reset", async () => {
    const clock = new ManualClock({ gated: true });
    const client = fw.client({ clock });
    const receiver = await fw.receiver();
    await subscribe(client, receiver);
    receiver.statuses = [500, 500, 500, 500, 500];
    await rename(client, "one.pdf");
    await until(() => clock.waits.length > 0);
    // The retry waits until the gate opens, so a reset that waited for it would never return.
    expect((await client.post("/_control/reset")).status).toBe(200);
    expect((await (await client.get("/_control/deliveries")).json()).value).toEqual([]);
    clock.open();
    await client.post("/_control/flush");
    expect(receiver.notifications).toHaveLength(1);
  });

  it("are dropped when the subscription is deleted", async () => {
    const clock = new ManualClock({ gated: true });
    const client = fw.client({ clock });
    const receiver = await fw.receiver();
    const subscription = await subscribe(client, receiver);
    receiver.statuses = [500];
    await rename(client, "one.pdf");
    await until(() => clock.waits.length > 0);
    expect((await client.delete(`/v1.0/subscriptions/${subscription.id}`)).status).toBe(204);
    clock.open();
    const [delivery] = await deliveries(client);
    expect([delivery!.state, delivery!.attempts.length]).toEqual(["dropped", 1]);
    expect(receiver.notifications).toHaveLength(1);
  });

  it("are dropped when the subscription expires", async () => {
    const clock = new ManualClock({ gated: true });
    const client = fw.client({ clock });
    const receiver = await fw.receiver();
    await subscribe(client, receiver);
    receiver.statuses = [500];
    await rename(client, "one.pdf");
    await until(() => clock.waits.length > 0);
    await client.post("/_control/clock", { json: { now: "2026-10-04T00:00:00Z" } }); // after EXPIRES
    clock.open();
    const [delivery] = await deliveries(client);
    expect([delivery!.state, delivery!.attempts.length]).toEqual(["dropped", 1]);
    expect(receiver.notifications).toHaveLength(1);
  });
});

describe("resets", () => {
  it("refuse a subscription validated across one", async () => {
    const client = fw.client({ policy: PATIENT });
    const receiver = await fw.receiver();
    await client.post("/_control/clock", { json: { now: NOW } });
    receiver.validation = "held";
    const pending = client.post("/v1.0/subscriptions", { json: request(receiver) });
    await until(() => receiver.tokens.length > 0);
    expect((await client.post("/_control/reset")).status).toBe(200);
    receiver.release();
    const response = await pending;
    expect(response.status, await response.clone().text()).toBe(503);
    expect((await response.json()).error.code).toBe("serviceNotAvailable");
    await client.post("/_control/clock", { json: { now: NOW } });
    await rename(client, "one.pdf");
    expect(await deliveries(client)).toEqual([]);
  });

  /** The reset waits for the deliveries it cancels; a change landing then is dropped too. */
  it("let a change that lands during one notify nobody", async () => {
    const clock = new Clock();
    clock.pinned = new Date(NOW);
    const notifier = new Notifier(clock, FAST);
    try {
      const held = await fw.receiver();
      const receiver = await fw.receiver();
      held.holdNotifications = true;
      for (const target of [held, receiver]) {
        await notifier.subscribe("kestrel", SubscriptionRequestSchema.parse(request(target)));
      }
      notifier.changed("kestrel", 1);
      await until(() => held.notifications.length > 0 && notifier.deliveries[1]?.state === "delivered");
      const resetting = notifier.reset(); // it now waits for the delivery it cancelled
      notifier.changed("kestrel", 2);
      await resetting;
      await notifier.flush();
      expect(receiver.notifications).toHaveLength(1);
      expect(notifier.deliveries).toEqual([]);
    } finally {
      await notifier.close();
    }
  });

  /** The reset loads a corpus without Kestrel's site, so Kestrel's token opens nothing. */
  it("authorise a request whose body arrives after one as a fresh request", async () => {
    const client = fw.client();
    const receiver = await fw.receiver();
    const body = slowBody(request(receiver));
    const pending = client.post("/v1.0/subscriptions", {
      body: body.stream,
      headers: { "Content-Type": "application/json" },
    });
    await body.reading;
    const manifest = join(fw.corpus.dir, "manifest.json");
    const data = JSON.parse(readFileSync(manifest, "utf8"));
    delete data.sites.kestrel;
    writeFileSync(manifest, JSON.stringify(data));
    expect((await client.post("/_control/reset")).status).toBe(200);
    body.send();
    const response = await pending;
    expect(response.status, await response.clone().text()).toBe(401);
    expect(receiver.tokens).toEqual([]);
  });
});

describe("subscription ids", () => {
  it.each([2, 5])("differ for %i subscriptions validated at once", async (count) => {
    const client = fw.client({ policy: PATIENT });
    const receiver = await fw.receiver();
    await client.post("/_control/clock", { json: { now: NOW } });
    receiver.validation = "held"; // every request is mid-validation before any finishes
    const pending = Array.from({ length: count }, () =>
      client.post("/v1.0/subscriptions", { json: request(receiver) }),
    );
    await until(() => receiver.tokens.length === count);
    receiver.release();
    const responses = await Promise.all(pending);
    expect(responses.map((r) => r.status)).toEqual(Array(count).fill(201));
    const ids: string[] = await Promise.all(responses.map(async (r) => (await r.json()).id));
    expect(new Set(ids).size).toBe(count);
    expect(new Set(receiver.tokens).size).toBe(count);
    for (const id of ids) {
      // Each one was stored.
      const renewed = await client.patch(`/v1.0/subscriptions/${id}`, { json: { expirationDateTime: EXPIRES } });
      expect(renewed.status).toBe(200);
    }
    await rename(client, "one.pdf");
    const log = await deliveries(client);
    expect(log.map((d) => d.subscription_id).sort()).toEqual([...ids].sort());
    expect(receiver.notifications).toHaveLength(count);
  });

  /** Subscriptions live in memory, so a restart starts its counter again; ids mustn't. */
  it("differ between processes", async () => {
    const receiver = await fw.receiver();
    const first = await subscribe(fw.client(), receiver);
    const restarted = await subscribe(fw.client(), receiver);
    expect(first.id).not.toBe(restarted.id);
  });

  it("stay unique across resets", async () => {
    const client = fw.client();
    const receiver = await fw.receiver();
    const before = await subscribe(client, receiver);
    expect((await client.post("/_control/reset")).status).toBe(200);
    const after = await subscribe(client, receiver);
    expect(after.id).not.toBe(before.id);
    const renew = await client.patch(`/v1.0/subscriptions/${before.id}`, { json: { expirationDateTime: EXPIRES } });
    expect(renew.status).toBe(404);
  });
});

describe("managing a subscription", () => {
  it("renews and deletes it", async () => {
    const client = fw.client();
    const receiver = await fw.receiver();
    const subscription = await subscribe(client, receiver);
    const url = `/v1.0/subscriptions/${subscription.id}`;
    const renewed = await client.patch(url, { json: { expirationDateTime: "2026-10-20T12:00:00Z" } });
    expect(renewed.status).toBe(200);
    expect((await renewed.json()).expirationDateTime).toBe("2026-10-20T12:00:00Z");
    await rename(client, "one.pdf");
    const [notified] = await deliveries(client);
    expect(notified!.state).toBe("delivered");
    expect(receiver.notifications[0]!.value[0]!.subscriptionExpirationDateTime).toBe("2026-10-20T12:00:00Z");
    const tooFar = await client.patch(url, { json: { expirationDateTime: "2026-12-20T12:00:00Z" } });
    expect(tooFar.status).toBe(400);
    expect((await client.delete(url)).status).toBe(204);
    await rename(client, "two.pdf");
    expect(await deliveries(client)).toHaveLength(1);
    expect((await client.delete(url)).status).toBe(404);
    expect((await client.patch(url, { json: { expirationDateTime: EXPIRES } })).status).toBe(404);
  });

  it("an expired one goes quiet", async () => {
    const client = fw.client();
    const subscription = await subscribe(client, await fw.receiver());
    await client.post("/_control/clock", { json: { now: "2026-10-04T00:00:00Z" } });
    await rename(client, "one.pdf");
    expect(await deliveries(client)).toEqual([]);
    const url = `/v1.0/subscriptions/${subscription.id}`;
    expect((await client.patch(url, { json: { expirationDateTime: "2026-10-05T00:00:00Z" } })).status).toBe(404);
  });

  it("another site can't", async () => {
    const client = fw.client();
    const subscription = await subscribe(client, await fw.receiver());
    const url = `/v1.0/subscriptions/${subscription.id}`;
    expect((await client.delete(url, { headers: HARBOUR })).status).toBe(404);
    expect((await client.delete(url)).status).toBe(204);
  });
});
