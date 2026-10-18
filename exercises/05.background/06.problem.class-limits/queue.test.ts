// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { claim, claimWithinLimits, complete, enqueue, type EnqueueOptions } from "#learn/queue/queue";
import { workOnce } from "#learn/queue/worker";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!postgresAvailable)("per-class limits", () => {
  let t: TestDatabase;
  let tenant: string;
  let queue: string;

  const add = (payload: Record<string, unknown> = {}, options: EnqueueOptions = {}) =>
    withTenantOn(t.appDb, tenant, (tx) => enqueue(tx, tenant, queue, payload, options));
  // The 3,000-page filing, as a full sync queues it: twelve page ranges of 250, before anything else.
  const backfill = async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push(await add({ documentId: "filing", from: i * 250 + 1, to: (i + 1) * 250 }, { class: "backfill" }));
    }
    return ids;
  };
  const delta = () => add({ sync: "delta", reason: "webhook" }, { class: "incremental" });
  const state = async (id: string) => (await t.sql`SELECT state FROM jobs WHERE id = ${id}`)[0].state;
  /** Two workers, as the dev server runs them. The backfill may take one; the other stays free. */
  const LIMITS = { backfill: 1 };

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

  it("without caps, the backfill queued first takes both workers and the delta waits", async () => {
    await backfill();
    const deltaId = await delta();
    const a = (await claim(t.db, queue, "a", 30_000))!;
    const b = (await claim(t.db, queue, "b", 30_000))!;
    expect([a.class, b.class]).toEqual(["backfill", "backfill"]);
    expect(await state(deltaId)).toBe("queued");
  });

  it("never runs more of a class than its cap, even with eight workers claiming at once", async () => {
    await backfill();
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, w) => claimWithinLimits(t.db, queue, `worker-${w}`, 30_000, { backfill: 3 })),
    );
    const [{ running }] = await t.sql`
      SELECT count(*)::int AS running FROM jobs WHERE queue = ${queue} AND state = 'running'`;
    expect(
      running,
      running > 3
        ? "two workers counted at once and both took the last slot: count and claim under the advisory lock, in one transaction"
        : "the cap counts running jobs only: queued ones hold no worker",
    ).toBe(3);
    expect(claims.filter(Boolean)).toHaveLength(3);
  });

  it("holds back a class capped at 0, while a class with no cap runs", async () => {
    await backfill();
    const deltaId = await delta();
    const job = await claimWithinLimits(t.db, queue, "a", 30_000, { backfill: 0 });
    expect(job?.id, "a cap of 0 means none of that class; a class with no cap is never held back").toBe(deltaId);
    expect(await claimWithinLimits(t.db, queue, "b", 30_000, { backfill: 0 })).toBeNull();
  });

  it("doesn't count a crashed worker's job against the cap once its lease has run out", async () => {
    await backfill();
    expect((await claimWithinLimits(t.db, queue, "crashed", 150, LIMITS))?.class).toBe("backfill");
    expect(await claimWithinLimits(t.db, queue, "b", 30_000, LIMITS)).toBeNull();
    await sleep(250);
    expect(
      (await claimWithinLimits(t.db, queue, "b", 30_000, LIMITS))?.class,
      "count only running jobs whose lease is live (locked_until > now())",
    ).toBe("backfill");
  });

  it("applies the caps in the worker loop too, so a delta runs while a backfill range holds the other worker", async () => {
    await backfill();
    const ran: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const options = {
      db: t.db,
      queue,
      classLimits: LIMITS,
      handler: async (job: { class: string }) => {
        ran.push(job.class);
        if (job.class === "backfill") await held;
      },
    };
    const busy = workOnce(options, "a");
    await sleep(50);
    const deltaId = await delta();
    expect(await workOnce(options, "b")).toBe(true);
    expect(ran).toEqual(["backfill", "incremental"]);
    expect(await state(deltaId)).toBe("done");
    release();
    await busy;
  });

  it("lets a delta queued behind twelve page ranges take the free worker, with backfill capped at 1", async () => {
    const ranges = await backfill();
    const a = (await claimWithinLimits(t.db, queue, "a", 30_000, LIMITS))!;
    expect(a.id, "the oldest range goes first").toBe(ranges[0]);
    expect(
      await claimWithinLimits(t.db, queue, "b", 30_000, LIMITS),
      "eleven ranges wait, but backfill is at its cap of 1",
    ).toBeNull();

    const deltaId = await delta();
    const b = await claimWithinLimits(t.db, queue, "b", 30_000, LIMITS);
    expect(b?.id, "the delta is the youngest job, but its class has room").toBe(deltaId);

    await complete(t.db, b!, "b");
    expect(await claimWithinLimits(t.db, queue, "b", 30_000, LIMITS)).toBeNull();
    await complete(t.db, a, "a");
    expect((await claimWithinLimits(t.db, queue, "b", 30_000, LIMITS))?.id).toBe(ranges[1]);
  });
});
