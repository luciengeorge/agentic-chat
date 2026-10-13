// @vitest-environment node
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { handleWorkspaceWebhook } from "./-workspace";

const SUBSCRIPTION = "sub-1";
const CLIENT_STATE = "a-secret-client-state";

describe.skipIf(!postgresAvailable)("POST /api/webhooks/workspace", () => {
  let t: TestDatabase;
  let kestrel: string;
  let harbour: string;
  let kicks = 0;

  const send = (query: string, body?: unknown, init: RequestInit = {}) =>
    handleWorkspaceWebhook(
      new Request(`http://localhost:3000/api/webhooks/workspace?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        ...init,
      }),
      { db: t.appDb, kick: () => void (kicks += 1) },
    );

  const notification = (overrides: Record<string, string> = {}) => ({
    value: [
      {
        subscriptionId: SUBSCRIPTION,
        clientState: CLIENT_STATE,
        changeType: "updated",
        resource: "sites/kestrel/drive/root",
        ...overrides,
      },
    ],
  });

  const queued = () => t.sql`SELECT tenant_id, kind, payload FROM outbox ORDER BY created_at`;

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: kestrel }, { id: harbour }] = await t.sql`
      INSERT INTO organization (name, slug, created_at)
      VALUES ('Kestrel Pay', 'kestrel', now()), ('Harbour Health', 'harbour', now())
      RETURNING id`;
    const hash = createHash("sha256").update(CLIENT_STATE).digest("hex");
    await t.sql`INSERT INTO sync_state (tenant_id, connector, scope, subscription_id, client_state_hash)
                VALUES (${kestrel}, 'workspace', 'drive', ${SUBSCRIPTION}, ${hash})`;
  });

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    await t.sql`DELETE FROM outbox`;
    kicks = 0;
  });

  it("answers the validation handshake with the token as text/plain", async () => {
    const response = await send(`validationToken=${encodeURIComponent("Validation: <b>hi</b>")}`, undefined, {
      headers: { "content-type": "text/plain" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("Validation: <b>hi</b>");
  });

  it("queues a delta sync for the tenant and kicks the relay", async () => {
    const response = await send(`tenant=${kestrel}`, notification());
    expect(response.status).toBe(202);
    expect(await queued()).toEqual([{ tenant_id: kestrel, kind: "sync", payload: { mode: "delta" } }]);
    expect(kicks).toBe(1);
  });

  it("queues one sync for a burst of notifications", async () => {
    await send(`tenant=${kestrel}`, notification());
    expect((await send(`tenant=${kestrel}`, notification())).status).toBe(202);
    expect(await queued()).toHaveLength(1);
    expect(kicks).toBe(1);
  });

  it("refuses a wrong clientState, and queues nothing", async () => {
    const response = await send(`tenant=${kestrel}`, notification({ clientState: "guess" }));
    expect(response.status).toBe(403);
    expect(await queued()).toEqual([]);
    expect(kicks).toBe(0);
  });

  it("refuses an unknown subscription, and a tenant whose subscription it isn't", async () => {
    expect((await send(`tenant=${kestrel}`, notification({ subscriptionId: "sub-2" }))).status).toBe(403);
    expect((await send(`tenant=${harbour}`, notification())).status).toBe(403);
    expect(await queued()).toEqual([]);
  });

  it("refuses a request that isn't a notification", async () => {
    expect((await send("tenant=kestrel", notification())).status).toBe(400);
    expect((await send(`tenant=${kestrel}`, { value: [] })).status).toBe(400);
    expect((await send(`tenant=${kestrel}`, undefined, { body: "not json" })).status).toBe(400);
    expect((await send(`validationToken=${"x".repeat(2000)}`)).status).toBe(400);
  });
});
