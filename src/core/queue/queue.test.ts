// @vitest-environment node
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { claim, claimWithinLimits, complete, enqueue, fail, heartbeat, reclaimExpired } from "./queue";
import { workOnce } from "./worker";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!postgresAvailable)("the job queue", () => {
  let t: TestDatabase;
  let tenant: string;
  let queue: string;

  const add = (payload: Record<string, unknown> = {}, options = {}) =>
    withTenantOn(t.appDb, tenant, (tx) => enqueue(tx, tenant, queue, payload, options));
  const row = async (id: string) =>
    (await t.sql`SELECT state, attempts, last_error, locked_by FROM jobs WHERE id = ${id}`)[0];

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: tenant }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
  });

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(() => {
    queue = `q-${crypto.randomUUID()}`;
  });

  it("enqueues inside the tenant, where RLS hides it from other tenants", async () => {
    const id = await add({ documentId: "d1" });
    const [{ count }] = await t.sql`SELECT count(*)::int AS count FROM jobs WHERE id = ${id}`;
    expect(count).toBe(1);
    const elsewhere = await withTenantOn(t.appDb, crypto.randomUUID(), (tx) =>
      tx.execute(sql`SELECT id FROM jobs WHERE id = ${id}`),
    );
    expect(elsewhere).toHaveLength(0);
  });

  it("never gives two workers the same job, even claiming at once", async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, (_, i) => add({ i })));
    const claims = await Promise.all(Array.from({ length: 16 }, (_, w) => claim(t.db, queue, `worker-${w}`, 30_000)));
    const taken = claims.flatMap((job) => (job ? [job.id] : []));
    expect(taken).toHaveLength(10);
    expect(new Set(taken).size).toBe(10);
    expect(new Set(taken)).toEqual(new Set(ids));
  });

  it("brings a crashed worker's job back once its lease runs out, and the old worker can't finish it", async () => {
    const id = await add();
    const job = (await claim(t.db, queue, "crashed", 150))!;
    expect(await claim(t.db, queue, "other", 150)).toBeNull();
    await sleep(250);
    expect(await reclaimExpired(t.db, queue)).toEqual({ requeued: 1, dead: 0 });
    expect(await row(id)).toMatchObject({ state: "queued", last_error: "lease expired: worker crashed stopped" });
    const again = (await claim(t.db, queue, "other", 30_000))!;
    expect(again).toMatchObject({ id, attempts: 2, lockedBy: "other" });
    expect(await heartbeat(t.db, job, "crashed", 30_000)).toBe(false);
    expect(await complete(t.db, job, "crashed")).toBe(false);
    expect(await complete(t.db, again, "other")).toBe(true);
    expect(await row(id)).toMatchObject({ state: "done", attempts: 2 });
  });

  it("keeps a live worker's job while it heartbeats", async () => {
    const id = await add();
    const job = (await claim(t.db, queue, "alive", 200))!;
    for (let i = 0; i < 3; i++) {
      await sleep(100);
      expect(await heartbeat(t.db, job, "alive", 200)).toBe(true);
    }
    expect(await reclaimExpired(t.db, queue)).toEqual({ requeued: 0, dead: 0 });
    expect(await row(id)).toMatchObject({ state: "running", locked_by: "alive" });
  });

  it("backs a failed job off, then sends a poison job dead after max_attempts", async () => {
    const id = await add({}, { maxAttempts: 3 });
    const seen: number[] = [];
    const options = {
      db: t.db,
      queue,
      retryInMs: () => 0,
      handler: async (job: { attempts: number }) => {
        seen.push(job.attempts);
        throw new Error("poison");
      },
    };
    while (await workOnce(options)) {
      // Each pass claims the job again, until it's dead.
    }
    expect(seen).toEqual([1, 2, 3]);
    expect(await row(id)).toMatchObject({ state: "dead", attempts: 3, last_error: "poison" });
  });

  it("waits out the backoff before a retry", async () => {
    const id = await add();
    const job = (await claim(t.db, queue, "w", 30_000))!;
    expect(await fail(t.db, job, "w", "flaky", 60_000)).toBe("queued");
    expect(await claim(t.db, queue, "w", 30_000)).toBeNull();
    expect(await row(id)).toMatchObject({ state: "queued", attempts: 1, last_error: "flaky" });
  });

  it("runs jobs with one key one at a time, and keeps one waiting per key", async () => {
    const first = await add({ n: 1 }, { key: "run-1" });
    expect(await add({ n: 2 }, { key: "run-1" })).toBe(first);
    const running = (await claim(t.db, queue, "a", 30_000))!;
    const next = await add({ n: 3 }, { key: "run-1" });
    expect(next).not.toBe(first);
    expect(await claim(t.db, queue, "b", 30_000)).toBeNull();
    // A failure while a job with its key waits leaves the retry to the waiting one.
    expect(await fail(t.db, running, "a", "boom", 0)).toBe("done");
    expect((await claim(t.db, queue, "b", 30_000))!.id).toBe(next);
  });
  describe("classes: a backfill can't starve incremental sync", () => {
    // The 3,000-page filing as a full sync queues it: twelve page ranges of 250, queued before anything else.
    const backfill = () =>
      Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          add({ documentId: "filing", from: i * 250 + 1, to: (i + 1) * 250 }, { class: "backfill" }),
        ),
      );
    const delta = () => add({ sync: "delta", reason: "webhook" }, { class: "incremental" });
    // Two workers, as the dev server runs. The backfill may take one; the other stays free for incremental work.
    const LIMITS = { backfill: 1 };

    it("without caps, the backfill queued first holds every worker and the delta waits", async () => {
      await backfill();
      const deltaId = await delta();
      const a = (await claim(t.db, queue, "a", 30_000))!;
      const b = (await claim(t.db, queue, "b", 30_000))!;
      expect([a.class, b.class]).toEqual(["backfill", "backfill"]);
      expect(await row(deltaId)).toMatchObject({ state: "queued" });
    });

    it("with backfill capped, a delta queued behind twelve page ranges gets the free worker", async () => {
      await backfill();
      const a = (await claimWithinLimits(t.db, queue, "a", 30_000, LIMITS))!;
      expect(a.class).toBe("backfill");
      // The other worker finds nothing it may take: eleven ranges wait, but backfill is at its cap.
      expect(await claimWithinLimits(t.db, queue, "b", 30_000, LIMITS)).toBeNull();

      const deltaId = await delta();
      const b = (await claimWithinLimits(t.db, queue, "b", 30_000, LIMITS))!;
      expect(b).toMatchObject({ id: deltaId, class: "incremental" });

      await complete(t.db, b, "b");
      expect(await claimWithinLimits(t.db, queue, "b", 30_000, LIMITS)).toBeNull();
      await complete(t.db, a, "a");
      expect((await claimWithinLimits(t.db, queue, "b", 30_000, LIMITS))!.class).toBe("backfill");
    });

    it("never runs more of a class than its cap, even with many workers claiming at once", async () => {
      await backfill();
      const claims = await Promise.all(
        Array.from({ length: 8 }, (_, w) => claimWithinLimits(t.db, queue, `worker-${w}`, 30_000, { backfill: 3 })),
      );
      expect(claims.filter(Boolean)).toHaveLength(3);
      const [{ running }] = await t.sql`
        SELECT count(*)::int AS running FROM jobs WHERE queue = ${queue} AND state = 'running'`;
      expect(running).toBe(3);
    });

    it("lets the worker loop take the cap, so a delta runs while the backfill saturates its share", async () => {
      await backfill();
      const deltaId = await delta();
      const ran: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const options = {
        db: t.db,
        queue,
        classLimits: LIMITS,
        handler: async (job: { id: string; class: string }) => {
          ran.push(job.class);
          if (job.class === "backfill") await held;
        },
      };
      const busy = workOnce(options, "a");
      await sleep(50);
      expect(await workOnce(options, "b")).toBe(true);
      expect(ran).toEqual(["backfill", "incremental"]);
      expect(await row(deltaId)).toMatchObject({ state: "done" });
      release();
      await busy;
    });
  });
});
