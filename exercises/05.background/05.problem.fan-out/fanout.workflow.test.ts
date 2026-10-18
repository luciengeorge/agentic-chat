import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { getWorld } from "workflow/runtime";

import { postgresAvailable } from "@/db/testing";
import { loadWorld } from "@/fixtures/world";
import { ingestWorkflow } from "@/workflows/ingest";
import { type Stack, startStack } from "@/workflows/ingest-testing";
import { syncWorkflow } from "@/workflows/sync";

const world = loadWorld();
const FILING = "/Legal/Regulatory/FCA Annual Regulatory Return 2026.pdf";

describe.skipIf(!postgresAvailable)("the filing, fanned out", () => {
  let stack: Stack;
  let kestrel: string;

  beforeAll(async () => {
    stack = await startStack();
    kestrel = stack.tenants.kestrel;
    const sync = await start(syncWorkflow, [kestrel, null, "full", { subscribe: false }]);
    expect(await sync.returnValue).toMatchObject({ status: "synced" });
  }, 60_000);

  afterAll(async () => {
    await stack?.close();
  });

  it("ingests the 3,000-page filing as 12 child runs, and cites the CHG-2026-0612 note at page 2,417", async () => {
    const [document] = await stack.t.sql`
      SELECT id, version FROM documents WHERE external_id = ${world.itemId("kestrel", FILING)}`;
    const [outbox] = await stack.t.sql`
      SELECT id FROM outbox WHERE kind = 'ingest' AND payload->>'documentId' = ${document.id}`;
    const run = await start(ingestWorkflow, [kestrel, document.id, document.version, outbox.id]);
    expect(await run.returnValue).toEqual({ status: "ready", chunks: 5274 });

    const children = (await (await getWorld()).runs.list({ resolveData: "none" } as never)).data.filter((r) =>
      r.workflowName.includes("ingestRangeWorkflow"),
    );
    expect(children, "one child run per range of 250 pages").toHaveLength(12);

    const ranges = await stack.t.sql`
      SELECT ordinal / 100000 AS range, min(page_start) AS first, max(page_end) AS last, count(*)::int AS chunks
      FROM chunks WHERE document_id = ${document.id} GROUP BY 1 ORDER BY 1`;
    expect(
      ranges.map((r) => `${r.range}:${r.first}-${r.last}`),
      "each range writes its own pages",
    ).toEqual(Array.from({ length: 12 }, (_, i) => `${i}:${i * 250 + 1}-${(i + 1) * 250}`));
    const [cited] = await stack.t.sql`
      SELECT ordinal, page_start, page_end FROM chunks
      WHERE document_id = ${document.id} AND text LIKE '%CHG-2026-0612%'`;
    expect(cited).toEqual({ ordinal: 900333, page_start: 2417, page_end: 2417 });
  }, 120_000);
});
