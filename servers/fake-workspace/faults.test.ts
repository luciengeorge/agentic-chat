// @vitest-environment node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { type Client, ManualClock, setupFakeWorkspace, until } from "./testing";

const ITEMS = "/v1.0/sites/kestrel/drive/items";
const HARBOUR = { Authorization: "Bearer dev-workspace-harbour" };

const fw = setupFakeWorkspace();

async function addFault(client: Client, fault: Record<string, unknown>): Promise<void> {
  const response = await client.post("/_control/faults", { json: fault });
  expect(response.status, await response.clone().text()).toBe(201);
}

describe("throttling", () => {
  it("starts after some requests and lasts for a count", async () => {
    const client = fw.client();
    await addFault(client, {
      kind: "throttle",
      site: "kestrel",
      path_prefix: ITEMS,
      after_requests: 2,
      count: 2,
      retry_after_s: 7,
    });
    const responses: Response[] = [];
    for (let i = 0; i < 5; i++) responses.push(await client.get(`${ITEMS}/root`));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 429, 429, 200]);
    const throttled = responses[2]!;
    expect(throttled.headers.get("retry-after")).toBe("7");
    expect((await throttled.json()).error.code).toBe("TooManyRequests");
    // Other paths and other sites are untouched.
    expect((await client.get("/v1.0/sites/kestrel/drive/root")).status).toBe(200);
    expect((await client.get("/v1.0/sites/harbour/drive/items/root", { headers: HARBOUR })).status).toBe(200);
  });

  it("lasts until cleared", async () => {
    const client = fw.client();
    await addFault(client, { kind: "throttle" });
    for (let i = 0; i < 3; i++) {
      const response = await client.get(`${ITEMS}/root`);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("1");
    }
    expect((await client.delete("/_control/faults")).status).toBe(204);
    expect((await client.get(`${ITEMS}/root`)).status).toBe(200);
  });

  it("doesn't count rejected requests", async () => {
    const client = fw.client();
    await addFault(client, { kind: "throttle", after_requests: 1 });
    expect((await client.get(`${ITEMS}/root`, { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    expect((await client.get(`${ITEMS}/root`, { headers: HARBOUR })).status).toBe(403);
    expect((await client.get(`${ITEMS}/root`)).status).toBe(200);
    expect((await client.get(`${ITEMS}/root`)).status).toBe(429);
  });

  it("applies to subscriptions and the directory", async () => {
    const client = fw.client();
    await addFault(client, { kind: "throttle", path_prefix: "/v1.0/subscriptions" });
    await addFault(client, { kind: "throttle", path_prefix: "/v1.0/sites/kestrel/users" });
    expect((await client.post("/v1.0/subscriptions", { json: {} })).status).toBe(429);
    expect((await client.get("/v1.0/sites/kestrel/users")).status).toBe(429);
  });
});

describe("errors", () => {
  it("answer with the status asked for", async () => {
    const client = fw.client();
    await addFault(client, { kind: "error", count: 1 });
    await addFault(client, { kind: "error", status: 500, count: 1 });
    const unavailable = await client.get(`${ITEMS}/root`);
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error.code).toBe("serviceNotAvailable");
    expect(unavailable.headers.has("retry-after")).toBe(false);
    const failed = await client.get(`${ITEMS}/root`);
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe("generalException");
    expect((await client.get(`${ITEMS}/root`)).status).toBe(200);
  });

  it("can carry a Retry-After", async () => {
    const client = fw.client();
    await addFault(client, { kind: "error", retry_after_s: 3 });
    const response = await client.get(`${ITEMS}/root`);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("3");
  });
});

describe("latency", () => {
  it("stacks, runs out, and touches only its paths", async () => {
    const clock = new ManualClock();
    const client = fw.client({ clock });
    await addFault(client, { kind: "latency", latency_ms: 150, path_prefix: ITEMS });
    await addFault(client, { kind: "latency", latency_ms: 50, path_prefix: ITEMS, count: 1 });
    expect((await client.get(`${ITEMS}/root`)).status).toBe(200);
    expect((await client.get(`${ITEMS}/root`)).status).toBe(200);
    expect((await client.get("/v1.0/sites/kestrel/drive/root")).status).toBe(200);
    expect(clock.waits).toEqual([0.15, 0.05, 0.15]);
  });

  /** The request passed its corpus check before the wait; the corpus is gone after it. */
  it("held across a failed reset ends in 503", async () => {
    const clock = new ManualClock({ gated: true });
    const client = fw.client({ clock });
    await addFault(client, { kind: "latency", latency_ms: 100, path_prefix: ITEMS });
    const waiting = client.get(`${ITEMS}/root`);
    await until(() => clock.waits.length > 0);
    writeFileSync(join(fw.corpus.dir, "manifest.json"), "{}");
    expect((await client.post("/_control/reset")).status).toBe(503);
    clock.open();
    const response = await waiting;
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("serviceNotReady");
  });

  it("held on a subscribe across a failed reset ends in 503", async () => {
    const clock = new ManualClock({ gated: true });
    const client = fw.client({ clock });
    const receiver = await fw.receiver();
    await addFault(client, { kind: "latency", latency_ms: 100, path_prefix: "/v1.0/subscriptions" });
    const body = {
      changeType: "updated",
      notificationUrl: receiver.url,
      resource: "sites/kestrel/drive/root",
      expirationDateTime: new Date(Date.now() + 86_400_000).toISOString(),
      clientState: "s",
    };
    const waiting = client.post("/v1.0/subscriptions", { json: body });
    await until(() => clock.waits.length > 0);
    writeFileSync(join(fw.corpus.dir, "manifest.json"), "{}");
    expect((await client.post("/_control/reset")).status).toBe(503);
    clock.open();
    const response = await waiting;
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("serviceNotReady");
  });

  it("held across a reset meets none of the faults it cleared", async () => {
    const clock = new ManualClock({ gated: true });
    const client = fw.client({ clock });
    await addFault(client, { kind: "latency", latency_ms: 100, path_prefix: ITEMS });
    await addFault(client, { kind: "throttle", path_prefix: ITEMS });
    const waiting = client.get(`${ITEMS}/root`);
    await until(() => clock.waits.length > 0);
    expect((await client.post("/_control/reset")).status).toBe(200);
    clock.open();
    expect((await waiting).status).toBe(200);
  });

  /** The reset loads a corpus without Kestrel's site, so Kestrel's token opens nothing. */
  it("held across a reset answers as a fresh request", async () => {
    const clock = new ManualClock({ gated: true });
    const client = fw.client({ clock });
    await addFault(client, { kind: "latency", latency_ms: 100, path_prefix: ITEMS, count: 1 });
    const waiting = client.get(`${ITEMS}/root`);
    await until(() => clock.waits.length > 0);
    const manifest = join(fw.corpus.dir, "manifest.json");
    const data = JSON.parse(readFileSync(manifest, "utf8"));
    delete data.sites.kestrel;
    writeFileSync(manifest, JSON.stringify(data));
    expect((await client.post("/_control/reset")).status).toBe(200);
    clock.open();
    const held = await waiting;
    const fresh = await client.get(`${ITEMS}/root`);
    const freshBody = await fresh.json();
    expect([held.status, await held.json()]).toEqual([fresh.status, freshBody]);
    expect(freshBody.error.code).toBe("InvalidAuthenticationToken");
  });
});

it.each([
  { kind: "latency" },
  { kind: "explode" },
  { kind: "error", status: 200 },
  { kind: "throttle", count: 0 },
  { kind: "throttle", after_requests: -1 },
])("an invalid fault (%j) is 400", async (fault) => {
  const response = await fw.client().post("/_control/faults", { json: fault });
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalidRequest");
});
