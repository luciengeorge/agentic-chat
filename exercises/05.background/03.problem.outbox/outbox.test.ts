// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  type Deliver,
  documentPartition,
  enqueue,
  type OutboxRow,
  relayOnce,
  UndeliverableError,
} from "#learn/queue/outbox";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

describe.skipIf(!postgresAvailable)("the relay", () => {
  let t: TestDatabase;
  let kestrel: string;
  let harbour: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: kestrel }, { id: harbour }] = await t.sql`
      INSERT INTO organization (name, slug, created_at)
      VALUES ('Kestrel Pay', 'kestrel', now()), ('Harbour Health', 'harbour', now())
      RETURNING id`;
  });

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    await t.sql`DELETE FROM outbox`;
  });

  /** Rows written one transaction each, so their created_at orders them. */
  async function ingest(tenantId: string, documentId: string, ...versions: number[]) {
    const ids: string[] = [];
    for (const version of versions) {
      ids.push(
        await withTenantOn(t.appDb, tenantId, (tx) =>
          enqueue(tx, tenantId, { kind: "ingest", payload: { documentId, version } }, documentPartition(documentId)),
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

  const state = () =>
    t.sql`SELECT id, attempts, published_at IS NOT NULL AS published, failed_at IS NOT NULL AS failed, last_error
          FROM outbox ORDER BY created_at, id`;

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

  const DOC_A = "00000000-0000-4000-8000-00000000000a";
  const DOC_B = "00000000-0000-4000-8000-00000000000b";

  it("delivers every tenant's rows, oldest first, and marks them published", async () => {
    const [a1, a2] = await ingest(kestrel, DOC_A, 1, 2);
    const [b1] = await ingest(harbour, DOC_B, 1);
    const { seen, deliver } = recorder();

    const result = await relayOnce(t.db, deliver);

    expect(seen.map((row) => row.id)).toEqual([a1, a2, b1]);
    expect(seen[0]).toMatchObject({ tenantId: kestrel, kind: "ingest", payload: { documentId: DOC_A, version: 1 } });
    expect(result).toMatchObject({ published: [a1, a2, b1], retried: [], failed: [], outage: false });
    expect((await state()).every((row) => row.published && row.attempts === 1)).toBe(true);
    expect((await relayOnce(t.db, deliver)).published).toEqual([]);
  });

  it("sees nothing on the app role, which is why the relay runs on the owner", async () => {
    await ingest(kestrel, DOC_A, 1);
    expect(await relayOnce(t.appDb, recorder().deliver)).toMatchObject({ published: [] });
  });

  it("keeps a partition in order: a failure holds back the rows behind it, not other partitions", async () => {
    const [a1, a2] = await ingest(kestrel, DOC_A, 1, 2);
    const [b1] = await ingest(kestrel, DOC_B, 1);
    const delivered: string[] = [];
    const result = await relayOnce(t.db, async (row) => {
      if (row.id === a1) throw new Error("world busy");
      delivered.push(row.id);
    });

    expect(delivered, "a failed row holds back the rows behind it in its partition: stop there").toEqual([b1]);
    expect(result, "rows of other partitions still go out").toMatchObject({ published: [b1], retried: [a1] });
    expect(await state()).toEqual([
      { id: a1, attempts: 1, published: false, failed: false, last_error: "Error: world busy" },
      { id: a2, attempts: 0, published: false, failed: false, last_error: null },
      { id: b1, attempts: 1, published: true, failed: false, last_error: null },
    ]);
  });

  it("marks a row failed after its last attempt, then moves on to the next", async () => {
    const [a1, a2] = await ingest(kestrel, DOC_A, 1, 2);
    const failing: Deliver = async (row) => {
      if (row.id === a1) throw new Error("bad");
    };
    expect((await relayOnce(t.db, failing, { maxAttempts: 2 })).retried).toEqual([a1]);
    expect((await relayOnce(t.db, failing, { maxAttempts: 2 })).failed).toEqual([a1]);
    expect((await relayOnce(t.db, failing, { maxAttempts: 2 })).published).toEqual([a2]);
    expect((await state()).map((row) => [row.attempts, row.failed, row.published])).toEqual([
      [2, true, false],
      [1, false, true],
    ]);
  });

  it("fails an undeliverable row at once", async () => {
    const [a1] = await ingest(kestrel, DOC_A, 1);
    const result = await relayOnce(t.db, async () => {
      throw new UndeliverableError("unknown kind");
    });
    expect(result.failed).toEqual([a1]);
    expect(await state()).toMatchObject([
      { attempts: 1, failed: true, last_error: "UndeliverableError: unknown kind" },
    ]);
  });

  it("takes at most batchSize rows a pass, the oldest", async () => {
    const [a1, a2] = await ingest(kestrel, DOC_A, 1, 2);
    await ingest(kestrel, DOC_B, 1);
    const { seen, deliver } = recorder();
    const result = await relayOnce(t.db, deliver, { batchSize: 2 });
    expect(
      seen.map((row) => row.id),
      "a pass takes at most batchSize rows: limit the batch",
    ).toEqual([a1, a2]);
    expect(result.published).toEqual([a1, a2]);
  });

  it("lets a second relay pass over the rows the first holds, without waiting for them", async () => {
    const [a1] = await ingest(kestrel, DOC_A, 1);
    const [b1] = await ingest(kestrel, DOC_B, 1);
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered = () => {};
    const inFirst = new Promise<void>((resolve) => (entered = resolve));

    const first = relayOnce(
      t.db,
      async () => {
        entered();
        await held;
      },
      { batchSize: 1 },
    );
    try {
      await Promise.race([
        inFirst,
        first.then(() => {
          throw new Error("the first relay returned without delivering a row");
        }),
      ]);
      const { seen, deliver } = recorder();
      await within(
        relayOnce(t.db, deliver),
        2_000,
        "the second relay waited for the row the first holds: pass over locked rows with SKIP LOCKED",
      );
      expect(
        seen.map((row) => row.id),
        "the second relay took a row the first holds: lock the batch FOR UPDATE, so it's delivered once",
      ).toEqual([b1]);
    } finally {
      release();
    }
    expect((await first).published).toEqual([a1]);
  });
});
