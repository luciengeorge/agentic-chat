import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Run, start } from "workflow/api";

import { type Deliver, relayOnce } from "#learn/queue/outbox";
import { postgresAvailable } from "@/db/testing";
import { loadWorld } from "@/fixtures/world";
import { ingestWorkflow } from "@/workflows/ingest";
import { type Stack, startStack } from "@/workflows/ingest-testing";
import { syncWorkflow } from "@/workflows/sync";

const world = loadWorld();

describe.skipIf(!postgresAvailable)("the relay, in real runs", () => {
  let stack: Stack;
  let kestrel: string;

  const pending = () =>
    stack.t.sql<{ id: string }[]>`
      SELECT id FROM outbox WHERE published_at IS NULL AND failed_at IS NULL ORDER BY created_at, id`;

  beforeAll(async () => {
    stack = await startStack();
    kestrel = stack.tenants.kestrel;
  }, 60_000);

  afterAll(async () => {
    await stack?.close();
  });

  it("relays the 40 ingest rows a full sync of Kestrel wrote, 20 a pass, oldest first", async () => {
    const sync = await start(syncWorkflow, [kestrel, null, "full", { subscribe: false }]);
    expect(await sync.returnValue).toMatchObject({ drive: { files: 40, ingest: 40 } });
    const written = (await pending()).map((row) => row.id);
    expect(written).toHaveLength(40);

    const seen: string[] = [];
    const record: Deliver = async (row) => void seen.push(row.id);
    const passes = [];
    for (let i = 0; i < 3; i++) passes.push((await relayOnce(stack.t.db, record)).published.length);
    expect(passes, "a pass takes a batch of batchSize (20) rows").toEqual([20, 20, 0]);
    expect(seen, "every row once, oldest first").toEqual(written);
    expect(await pending()).toEqual([]);
  }, 60_000);

  it("delivers a row again after a crash before it was marked published, and the second run stops", async () => {
    const path = "/Finance/Month-End Close Checklist.md";
    const [{ id: documentId }] = await stack.t.sql`
      SELECT id FROM documents WHERE external_id = ${world.itemId("kestrel", path)}`;
    const [{ id: rowId }] = await stack.t.sql`
      UPDATE outbox SET published_at = NULL, attempts = 0
      WHERE kind = 'ingest' AND payload->>'documentId' = ${documentId}
      RETURNING id`;

    // What relay-deliver does for an ingest row, keeping the runs so the test can wait for them.
    const runs: Run<unknown>[] = [];
    let crashes = 1;
    const startRun: Deliver = async (row) => {
      const { documentId: id, version } = row.payload as { documentId: string; version: number };
      runs.push(await start(ingestWorkflow, [row.tenantId, id, version, row.id]));
      if (crashes-- > 0) throw new Error("the relay died after start(), before marking the row published");
    };
    expect((await relayOnce(stack.t.db, startRun)).retried, "a failed delivery counts an attempt").toEqual([rowId]);
    // The first run goes ahead: it claims the row and ingests.
    expect(await runs[0].returnValue).toMatchObject({ status: "ready" });

    expect((await relayOnce(stack.t.db, startRun)).published, "the next pass delivers the row again").toEqual([rowId]);
    expect(runs).toHaveLength(2);
    expect(await runs[1].returnValue, "the second run finds the row claimed by the first").toEqual({
      status: "duplicate",
      chunks: 0,
    });
    const [row] = await stack.t.sql`SELECT attempts, claimed_by FROM outbox WHERE id = ${rowId}`;
    expect(row).toEqual({ attempts: 2, claimed_by: runs[0].runId });
  }, 60_000);
});
