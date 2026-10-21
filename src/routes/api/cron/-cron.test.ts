// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { enqueue as enqueueJob } from "#learn/queue/queue";
import { workOnce } from "#learn/queue/worker";
import { type Deliver, documentPartition, enqueue, OutageError } from "@/db/outbox";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { REQUIRED_IN_PROD } from "@/lib/env-check";

import { cronAuthorized, handleCron, OTHER_METHODS, queuePass, relayPass, schedulerPass, syncPass } from "./-cron";

const SECRET = "s3cret-for-the-cron-routes-0123456789abcdef";
const ROOT = join(import.meta.dirname, "../../../..");

const get = (authorization?: string) =>
  new Request("https://agentic-chat.example/api/cron/relay", {
    headers: authorization === undefined ? {} : { authorization },
  });

describe("cron auth", () => {
  let calls = 0;
  const pass = async () => ({ did: ++calls });

  beforeEach(() => {
    calls = 0;
  });

  it("runs the pass once for Vercel's header, and reports what it did", async () => {
    const response = await handleCron(get(`Bearer ${SECRET}`), "relay", pass, SECRET);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ job: "relay", did: 1 });
    expect(calls).toBe(1);
  });

  it.each([
    ["no header", undefined],
    ["the wrong secret", "Bearer not-the-secret"],
    ["the secret with something after it", `Bearer ${SECRET}x`],
    ["the secret without the Bearer scheme", SECRET],
    ["another scheme", `Basic ${SECRET}`],
    ["a lowercase scheme", `bearer ${SECRET}`],
    ["an empty bearer", "Bearer "],
  ])("refuses %s with 401, and runs nothing", async (_, header) => {
    const response = await handleCron(get(header), "relay", pass, SECRET);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(calls).toBe(0);
  });

  it.each([
    ["unset", undefined],
    ["blank", "  "],
  ])("refuses every caller with 503 when CRON_SECRET is %s", async (_, secret) => {
    for (const header of [undefined, "Bearer ", "Bearer undefined", `Bearer ${secret}`]) {
      const response = await handleCron(get(header), "relay", pass, secret);
      expect(response.status).toBe(503);
    }
    expect(cronAuthorized(get("Bearer undefined"), undefined)).toBe(false);
    expect(calls).toBe(0);
  });

  it("answers 500 with the error when the pass throws", async () => {
    const response = await handleCron(
      get(`Bearer ${SECRET}`),
      "relay",
      () => Promise.reject(new Error("db down")),
      SECRET,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ job: "relay", error: "db down" });
  });

  it("answers every other method with 405, so a cron path never falls through to a page", async () => {
    for (const refuse of Object.values(OTHER_METHODS)) {
      const response = refuse();
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
    }
    expect(Object.keys(OTHER_METHODS).sort()).toEqual(["DELETE", "PATCH", "POST", "PUT"]);
  });

  it("is a secret the prod boot check asks for", () => {
    expect(Object.keys(REQUIRED_IN_PROD)).toContain("CRON_SECRET");
  });
});

describe("vercel.json", () => {
  const crons = (
    JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] }
  ).crons;
  const routes = readdirSync(join(ROOT, "src/routes/api/cron")).filter((file) => /^[a-z][a-z-]*\.ts$/.test(file));

  it("schedules every cron route once, and nothing else", () => {
    expect(crons.map((cron) => cron.path).sort()).toEqual(
      routes.map((file) => `/api/cron/${file.slice(0, -3)}`).sort(),
    );
  });

  it("points each schedule at a GET route of that path", () => {
    for (const { path } of crons) {
      const source = readFileSync(join(ROOT, "src/routes", `${path}.ts`), "utf8");
      expect(source).toContain(`createFileRoute("${path}")`);
      expect(source).toMatch(/GET: \(\{ request \}\) => handleCron\(request,/);
      expect(source).toContain("...OTHER_METHODS");
    }
  });

  it("uses only what Vercel's cron syntax allows: five numeric fields, never both days set", () => {
    for (const { schedule } of crons) {
      const fields = schedule.split(" ");
      expect(fields, schedule).toHaveLength(5);
      for (const field of fields) expect(field, schedule).toMatch(/^(\*|\d+)(-\d+)?(\/\d+)?(,(\d+)(-\d+)?)*$/);
      expect(fields[2] === "*" || fields[4] === "*", schedule).toBe(true);
    }
  });
});

describe("cron passes that need no database", () => {
  it("the scheduler ticks, then reconciles, once each", async () => {
    const order: string[] = [];
    const result = await schedulerPass(
      true,
      async () => (order.push("tick"), [{}, {}]),
      async () => (order.push("reconcile"), ["run-1"]),
    );
    expect(order).toEqual(["tick", "reconcile"]);
    expect(result).toEqual({ fired: 2, reconciled: ["run-1"] });
  });

  it("the scheduler and the queue skip when their runner isn't the one in use", async () => {
    const never = async (): Promise<never> => {
      throw new Error("ran");
    };
    expect(await schedulerPass(false, never, never)).toEqual({ skipped: "AGENT_RUNNER isn't workflow" });
    expect(await queuePass(false, never)).toEqual({ skipped: "AGENT_RUNNER isn't queue" });
  });

  it("the queue claims no new job once its time budget is spent", async () => {
    let clock = 0;
    let worked = 0;
    const result = await queuePass(true, async () => ((clock += 20_000), (worked += 1), true), {
      budgetMs: 45_000,
      now: () => clock,
    });
    expect(result).toEqual({ worked: 3 });
    expect(worked).toBe(3);
  });
});

describe.skipIf(!postgresAvailable)("cron passes on a database", () => {
  let t: TestDatabase;
  let kestrel: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: kestrel }] = await t.sql`
      INSERT INTO organization (name, slug, created_at)
      VALUES ('Kestrel Pay', 'kestrel', now()), ('Harbour Health', 'harbour', now())
      RETURNING id`;
  });

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    await t.sql`DELETE FROM outbox`;
    await t.sql`DELETE FROM jobs`;
  });

  async function outboxRows(count: number) {
    for (let i = 0; i < count; i++) {
      await withTenantOn(t.appDb, kestrel, (tx) =>
        enqueue(
          tx,
          kestrel,
          { kind: "ingest", payload: { documentId: `doc-${i}`, version: 1 } },
          documentPartition(`doc-${i}`),
        ),
      );
    }
  }

  it("the relay delivers at most its batches, and the next call carries on", async () => {
    await outboxRows(12);
    const delivered: string[] = [];
    const deliver: Deliver = async (row) => void delivered.push(row.id);

    const first = await relayPass(t.db, deliver, { batchSize: 5, maxBatches: 2 });
    expect(first).toMatchObject({ batches: 2, published: 10, outage: false });
    const second = await relayPass(t.db, deliver, { batchSize: 5, maxBatches: 2 });
    expect(second).toMatchObject({ batches: 1, published: 2 });
    expect(new Set(delivered).size).toBe(12);
    const [{ left }] = await t.sql`SELECT count(*)::int AS left FROM outbox WHERE published_at IS NULL`;
    expect(left).toBe(0);
  });

  it("the relay stops at an outage, counting no attempt", async () => {
    await outboxRows(3);
    const result = await relayPass(t.db, async () => {
      throw new OutageError("connection refused");
    });
    expect(result).toMatchObject({ batches: 1, published: 0, outage: true });
    const rows = await t.sql`SELECT attempts FROM outbox`;
    expect(rows.map((row) => row.attempts)).toEqual([0, 0, 0]);
  });

  it("the sync asks once per tenant, and not again while those wait", async () => {
    expect(await syncPass(t.db, t.appDb, true)).toEqual({ tenants: 2, queued: 2 });
    expect(await syncPass(t.db, t.appDb, true)).toEqual({ tenants: 2, queued: 0 });
    const rows = await t.sql`SELECT kind, payload FROM outbox`;
    expect(rows.map((row) => [row.kind, row.payload.mode])).toEqual([
      ["sync", "delta"],
      ["sync", "delta"],
    ]);
  });

  it("the sync asks for at most its tenants a pass, and the next pass starts with the ones left out", async () => {
    const [{ id: third }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Third Co', 'third', now()) RETURNING id`;
    try {
      const all = [kestrel, ...(await t.sql`SELECT id FROM organization WHERE id <> ${kestrel}`).map((r) => r.id)];
      const synced = async () =>
        (await t.sql`SELECT tenant_id FROM outbox WHERE kind = 'sync' ORDER BY created_at`).map((r) => r.tenant_id);

      expect(await syncPass(t.db, t.appDb, true, { maxTenants: 2 })).toEqual({ tenants: 2, queued: 2 });
      const first = await synced();
      expect(first, "two of three tenants, not all three: a pass is bounded").toHaveLength(2);

      // Those two syncs ran (claimed), so each could be asked for again; the tenant left out still goes first.
      await t.sql`UPDATE outbox SET published_at = now(), claimed_by = 'run'`;
      expect(await syncPass(t.db, t.appDb, true, { maxTenants: 2 })).toEqual({ tenants: 2, queued: 2 });
      const second = (await synced()).slice(2);
      const leftOut = all.find((id) => !first.includes(id));
      expect(second[0], "the tenant the last pass left out, before anyone asked for again").toBe(leftOut);
      expect(second[1], "then the one asked for longest ago").toBe(first[0]);

      await t.sql`UPDATE outbox SET published_at = now(), claimed_by = 'run'`;
      await syncPass(t.db, t.appDb, true, { maxTenants: 2 });
      const counts = new Map<string, number>();
      for (const id of await synced()) counts.set(id, (counts.get(id) ?? 0) + 1);
      expect([...counts.values()].sort(), "three passes of two: every tenant twice").toEqual([2, 2, 2]);
    } finally {
      await t.sql`DELETE FROM outbox`;
      await t.sql`DELETE FROM organization WHERE id = ${third}`;
    }
  });

  it("the sync queues nothing when no workspace is configured", async () => {
    expect(await syncPass(t.db, t.appDb, false)).toEqual({
      skipped: "no workspace is configured (FAKE_WORKSPACE_URL)",
    });
    const [{ count }] = await t.sql`SELECT count(*)::int AS count FROM outbox`;
    expect(count).toBe(0);
  });

  it("the queue works at most its jobs a call, then stops when none is due", async () => {
    for (let i = 0; i < 7; i++) await enqueueJob(t.db, kestrel, "cron-test", { i });
    const handled: number[] = [];
    const once = () =>
      workOnce<{ i: number }>({
        db: t.db,
        queue: "cron-test",
        handler: async (job) => void handled.push(job.payload.i),
      });

    expect(await queuePass(true, once, { maxJobs: 5 })).toEqual({ worked: 5 });
    expect(await queuePass(true, once, { maxJobs: 5 })).toEqual({ worked: 2 });
    expect(await queuePass(true, once, { maxJobs: 5 })).toEqual({ worked: 0 });
    expect(handled.sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const states = await t.sql`SELECT state FROM jobs WHERE queue = 'cron-test'`;
    expect(states.every((row) => row.state === "done")).toBe(true);
  });
});
