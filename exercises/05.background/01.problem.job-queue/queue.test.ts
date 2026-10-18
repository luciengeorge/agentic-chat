// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { claim, complete, enqueue, type EnqueueOptions, heartbeat, reclaimExpired } from "#learn/queue/queue";
import { workOnce } from "#learn/queue/worker";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!postgresAvailable)("claiming a job", () => {
  let t: TestDatabase;
  let tenant: string;
  let queue: string;

  const add = (payload: Record<string, unknown> = {}, options: EnqueueOptions = {}) =>
    withTenantOn(t.appDb, tenant, (tx) => enqueue(tx, tenant, queue, payload, options));
  const row = async (id: string) =>
    (
      await t.sql<{ state: string; attempts: number; locked_by: string | null; wait_s: number }[]>`
        SELECT state, attempts, locked_by, round(extract(epoch FROM run_at - updated_at)) AS wait_s
        FROM jobs WHERE id = ${id}`
    )[0];

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

  it("never gives two workers the same job: 16 workers claiming at once over 10 jobs get 10 different ones", async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, (_, i) => add({ range: i + 1 })));
    const claims = await Promise.all(Array.from({ length: 16 }, (_, w) => claim(t.db, queue, `worker-${w}`, 30_000)));
    const taken = claims.flatMap((job) => (job ? [job.id] : []));
    expect(new Set(taken).size, "a job went to two workers: lock the row as you pick it (FOR UPDATE)").toBe(
      taken.length,
    );
    expect(taken.length, "workers got nothing while jobs waited: pass over locked rows (SKIP LOCKED)").toBe(10);
    expect(new Set(taken)).toEqual(new Set(ids));
  });

  it("doesn't make a worker wait while another holds a job it hasn't committed yet", async () => {
    const [held, free] = [await add({ n: 1 }), await add({ n: 2 })];
    await t.db.transaction(async (tx) => {
      expect((await claim(tx, queue, "slow", 30_000))?.id).toBe(held);
      const other = await Promise.race([claim(t.db, queue, "quick", 30_000), sleep(1_000).then(() => "waited")]);
      expect(other, "the second worker waited on the first one's lock: pass over locked rows (SKIP LOCKED)").not.toBe(
        "waited",
      );
      expect((other as { id: string } | null)?.id).toBe(free);
    });
  });

  it("takes the oldest due job first, marks it running under a lease, and counts the attempt", async () => {
    const first = await add({ n: 1 });
    const later = await add({ n: 2 }, { delayMs: 60_000 });
    const second = await add({ n: 3 });
    const job = await claim(t.db, queue, "a", 30_000);
    expect(job?.id, "the oldest due job goes first").toBe(first);
    expect(job?.attempts, "claim counts the attempt: 0 before, 1 once taken").toBe(1);
    expect(job).toMatchObject({ state: "running", lockedBy: "a" });
    expect((await claim(t.db, queue, "b", 30_000))?.id).toBe(second);
    expect(await claim(t.db, queue, "c", 30_000), "a job isn't due before its run_at").toBeNull();
    expect(await row(later)).toMatchObject({ state: "queued", attempts: 0 });
  });

  it("brings a crashed worker's job back once its lease runs out, and the old worker can't finish it", async () => {
    const id = await add();
    const job = (await claim(t.db, queue, "crashed", 150))!;
    expect(await claim(t.db, queue, "other", 150)).toBeNull();
    await sleep(250);
    expect(await reclaimExpired(t.db, queue), "the lease (locked_until) should have run out").toEqual({
      requeued: 1,
      dead: 0,
    });
    const again = (await claim(t.db, queue, "other", 30_000))!;
    expect(again).toMatchObject({ id, attempts: 2, lockedBy: "other" });
    expect(await heartbeat(t.db, job, "crashed", 30_000)).toBe(false);
    expect(await complete(t.db, job, "crashed")).toBe(false);
    expect(await complete(t.db, again, "other")).toBe(true);
  });

  it("runs jobs that share a key one at a time, while other jobs go ahead", async () => {
    const run = await add({ step: 1 }, { key: "run-1" });
    expect((await claim(t.db, queue, "a", 30_000))?.id).toBe(run);
    const next = await add({ step: 2 }, { key: "run-1" });
    const other = await add({ step: 1 }, { key: "run-2" });
    expect((await claim(t.db, queue, "b", 30_000))?.id, "run-1 is busy: use the keyFree condition").toBe(other);
    expect(await claim(t.db, queue, "c", 30_000)).toBeNull();
    expect(await row(next)).toMatchObject({ state: "queued" });
  });

  it("backs a poison job off 1, 2, 4 and 8 seconds, then sends it dead on its fifth attempt", async () => {
    const id = await add({ documentId: "broken" });
    const options = {
      db: t.db,
      queue,
      handler: async () => {
        throw new Error("not a readable PDF");
      },
    };
    const waits: number[] = [];
    for (let pass = 0; pass < 8; pass++) {
      if (!(await workOnce(options))) break;
      const after = await row(id);
      if (after.state === "dead") break;
      waits.push(Number(after.wait_s));
      // Skip the wait instead of sleeping through it.
      await t.sql`UPDATE jobs SET run_at = now() WHERE id = ${id}`;
    }
    expect(waits, "the worker's backoff doubles with the attempts claim counts").toEqual([1, 2, 4, 8]);
    expect(await row(id), "after max_attempts (5) the job goes dead").toMatchObject({ state: "dead", attempts: 5 });
    expect(await workOnce(options)).toBe(false);
  });
});
