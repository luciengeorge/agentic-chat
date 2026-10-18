import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { start } from "workflow/api";

import { type Deliver, OutageError, relayOnce } from "#learn/queue/outbox";
import { postgresAvailable } from "@/db/testing";
import { type Stack, startStack } from "@/workflows/ingest-testing";
import { syncWorkflow } from "@/workflows/sync";

describe.skipIf(!postgresAvailable)("an outage, in real rows", () => {
  let stack: Stack;

  const pending = () =>
    stack.t.sql<{ id: string; attempts: number }[]>`
      SELECT id, attempts FROM outbox WHERE published_at IS NULL AND failed_at IS NULL ORDER BY created_at, id`;

  beforeAll(async () => {
    stack = await startStack();
  }, 60_000);

  afterAll(async () => {
    await stack?.close();
  });

  it("leaves a full sync's 40 rows waiting at 0 attempts when the world goes down at the 8th start", async () => {
    const sync = await start(syncWorkflow, [stack.tenants.kestrel, null, "full", { subscribe: false }]);
    expect(await sync.returnValue).toMatchObject({ drive: { files: 40, ingest: 40 } });
    const written = (await pending()).map((row) => row.id);
    expect(written).toHaveLength(40);

    const started: string[] = [];
    const down: Deliver = async (row) => {
      if (started.length === 7) throw new OutageError("connect ECONNREFUSED 127.0.0.1:3000");
      started.push(row.id);
    };
    expect(await relayOnce(stack.t.db, down), "an outage is reported, with nothing published").toEqual({
      published: [],
      retried: [],
      failed: [],
      skippedPartitions: [],
      outage: true,
    });
    expect(started, "7 starts went out before the 8th found the world down").toEqual(written.slice(0, 7));
    const after = await pending();
    expect(
      after.map((row) => row.id),
      "all 40 rows are still waiting, the 7 that went out included",
    ).toEqual(written);
    expect(
      after.filter((row) => row.attempts > 0),
      "no attempt was counted: the batch rolled back",
    ).toEqual([]);

    const again: string[] = [];
    const up: Deliver = async (row) => void again.push(row.id);
    expect((await relayOnce(stack.t.db, up)).published, "the world is back: the next pass takes 20").toHaveLength(20);
    expect(again.slice(0, 7), "the 7 that went out before the outage go out again").toEqual(started);
  }, 60_000);
});
