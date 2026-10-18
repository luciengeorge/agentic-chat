// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/db/create";

import {
  type Deliver,
  documentPartition,
  enqueue,
  OutageError,
  type OutboxRow,
  type RelayResult,
  relayOnce,
} from "#learn/queue/outbox";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

describe.skipIf(!postgresAvailable)("one relay per partition, and outages", () => {
  let t: TestDatabase;
  let kestrel: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: kestrel }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
  });

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    await t.sql`DELETE FROM outbox`;
  });

  /** Rows written one transaction each, so their created_at orders them. */
  async function ingest(documentId: string, ...versions: number[]) {
    const ids: string[] = [];
    for (const version of versions) {
      ids.push(
        await withTenantOn(t.appDb, kestrel, (tx) =>
          enqueue(tx, kestrel, { kind: "ingest", payload: { documentId, version } }, documentPartition(documentId)),
        ),
      );
    }
    return ids;
  }

  const recorder = () => {
    const seen: OutboxRow[] = [];
    const deliver: Deliver = async (row) => void seen.push(row);
    return { seen, deliver };
  };

  /** A relay whose delivery of `row` waits until `release()`; `entered` resolves once it's waiting there. */
  function holdAt(row: string, batchSize: number) {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let enter = () => {};
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const pass = relayOnce(
      t.db,
      async (r) => {
        if (r.id !== row) return;
        enter();
        await held;
      },
      { batchSize },
    );
    const ready = Promise.race([
      entered,
      pass.then(() => {
        throw new Error(`the first relay returned without delivering ${row}`);
      }),
    ]);
    return { pass, ready, release };
  }

  /** `promise`, or a failure with `message` once `ms` have passed. */
  async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)));
    try {
      return await Promise.race([promise, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  const advisoryLocks = async () => {
    const [{ n }] = await t.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
    return n;
  };

  const LOCK_OUTLIVED =
    "an advisory lock outlived its pass: take it with pg_try_advisory_xact_lock, which ends with the transaction";

  const DOC_A = "00000000-0000-4000-8000-00000000000a";
  const DOC_B = "00000000-0000-4000-8000-00000000000b";
  const DOC_C = "00000000-0000-4000-8000-00000000000c";

  it("skips a partition whose older row another relay has locked, before that relay even reaches it", async () => {
    const [c1] = await ingest(DOC_C, 1);
    const [a1, a2] = await ingest(DOC_A, 1, 2);
    // The first relay locks c1 and a1, and waits on c1: it hasn't taken DOC_A's partition yet.
    const first = holdAt(c1, 2);
    const { seen, deliver } = recorder();
    let second: RelayResult | undefined;
    try {
      await first.ready;
      second = await within(relayOnce(t.db, deliver), 2_000, "the second relay waited: take the lock without waiting");
    } finally {
      first.release();
    }
    expect(
      seen.map((row) => row.id),
      "version 2 went out while version 1, older, sat in the first relay's batch: also check for an older pending row",
    ).toEqual([]);
    expect(second?.skippedPartitions).toEqual([documentPartition(DOC_A)]);
    const firstResult = await first.pass;
    expect(await advisoryLocks(), LOCK_OUTLIVED).toBe(0);
    expect(firstResult.published).toEqual([c1, a1]);
    expect((await relayOnce(t.db, deliver)).published).toEqual([a2]);
  });

  it("skips a partition another relay is delivering, even for a row that committed late, older", async () => {
    const [a1] = await ingest(DOC_A, 1);
    const [b1] = await ingest(DOC_B, 1);
    const first = holdAt(a1, 1);
    const { seen, deliver } = recorder();
    let second: RelayResult | undefined;
    let a0 = "";
    try {
      await first.ready;
      // A slow transaction began before a1's and commits only now: its created_at is older than a1's.
      [{ id: a0 }] = await t.sql`
        INSERT INTO outbox (tenant_id, kind, payload, partition_key, created_at)
        SELECT tenant_id, kind, jsonb_build_object('documentId', ${DOC_A}::text, 'version', 0), partition_key,
               created_at - interval '1 second'
        FROM outbox WHERE id = ${a1}
        RETURNING id`;
      second = await within(
        relayOnce(t.db, deliver),
        2_000,
        "the second relay waited for the partition's lock: try it (pg_try_advisory_xact_lock) and skip when it's taken",
      );
    } finally {
      first.release();
    }
    expect(
      seen.map((row) => row.id),
      "the first relay is delivering DOC_A, and the late row has nothing older: only the partition's lock stops it",
    ).toEqual([b1]);
    expect(second?.skippedPartitions).toEqual([documentPartition(DOC_A)]);
    const firstResult = await first.pass;
    expect(await advisoryLocks(), LOCK_OUTLIVED).toBe(0);
    expect(firstResult.published).toEqual([a1]);
    expect((await relayOnce(t.db, deliver)).published).toEqual([a0]);
  });

  it("rolls the batch back on an outage, without counting attempts, and reports it", async () => {
    await ingest(DOC_A, 1);
    await ingest(DOC_B, 1);
    let calls = 0;
    const result = await relayOnce(t.db, async () => {
      calls += 1;
      if (calls === 2) throw new OutageError("world unreachable");
    }).catch((error: unknown) => error);
    expect(
      result,
      "an outage is reported, not thrown: catch the OutageError outside the transaction",
    ).not.toBeInstanceOf(Error);
    expect(result, "the batch rolled back, so nothing was published: every list is empty").toEqual({
      published: [],
      retried: [],
      failed: [],
      skippedPartitions: [],
      outage: true,
    });
    expect(
      await t.sql`SELECT attempts, published_at IS NOT NULL AS published FROM outbox ORDER BY created_at, id`,
      "an outage rolls the whole batch back, the row that went out first included: let the OutageError escape the transaction",
    ).toEqual([
      { attempts: 0, published: false },
      { attempts: 0, published: false },
    ]);
  });

  it("still throws an error that isn't an outage", async () => {
    const broken = {
      transaction: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    } as unknown as Db;
    const outcome = await relayOnce(broken, recorder().deliver).then(
      (result) => result,
      (error: unknown) => error,
    );
    expect(outcome, "only an OutageError is an outage: rethrow anything else").toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("connection terminated unexpectedly");
  });
});
