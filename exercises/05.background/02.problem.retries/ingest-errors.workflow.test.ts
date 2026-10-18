import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { getWorld } from "workflow/runtime";

import { postgresAvailable } from "@/db/testing";
import { loadWorld } from "@/fixtures/world";
import { ingestWorkflow } from "@/workflows/ingest";
import { type Stack, startStack } from "@/workflows/ingest-testing";
import { syncWorkflow } from "@/workflows/sync";

const world = loadWorld();

describe.skipIf(!postgresAvailable)("ingest runs that fail and retry", () => {
  let stack: Stack;
  let kestrel: string;

  const documentAt = async (path: string) => {
    const [row] = await stack.t.sql`
      SELECT id, version, status FROM documents WHERE external_id = ${world.itemId("kestrel", path)}`;
    return row;
  };
  const ingest = async (path: string) => {
    const document = await documentAt(path);
    const [outbox] = await stack.t.sql`
      SELECT id FROM outbox WHERE kind = 'ingest' AND payload->>'documentId' = ${document.id}
      ORDER BY created_at DESC LIMIT 1`;
    return start(ingestWorkflow, [kestrel, document.id, document.version, outbox.id]);
  };
  /** The download step's last attempt: 1 when it never retried. */
  const download = async (runId: string) => {
    const steps = await (await getWorld()).steps.list({ runId, resolveData: "none" } as never);
    return steps.data.find((step) => step.stepName.endsWith("storeBlob"))!;
  };
  const item = (path: string) => `/sites/kestrel/items/${world.itemId("kestrel", path)}`;

  beforeAll(async () => {
    stack = await startStack();
    kestrel = stack.tenants.kestrel;
    const sync = await start(syncWorkflow, [kestrel, null, "full", { subscribe: false }]);
    expect(await sync.returnValue).toMatchObject({ status: "synced" });
  }, 60_000);

  afterAll(async () => {
    await stack?.close();
  });

  it("fails a file that's gone from the drive on the first attempt: a 404 is fatal", async () => {
    const path = "/Company/Office Guide.pdf";
    expect((await stack.control("DELETE", item(path))).status).toBe(204);
    const run = await ingest(path);
    await expect(run.returnValue).rejects.toThrow(/404|itemNotFound/);
    expect(await download(run.runId), "a 404 was retried: it should be a FatalError").toMatchObject({
      status: "failed",
      attempt: 1,
    });
    expect(await documentAt(path)).toMatchObject({ status: "failed" });
  }, 60_000);

  it("fails bytes that aren't a PDF on the first attempt: the step's own FatalError passes through", async () => {
    const path = "/Sales/Pricing FAQ.pdf";
    await stack.control("PUT", `${item(path)}/content`, {
      content_base64: Buffer.from("not a pdf").toString("base64"),
    });
    const sync = await start(syncWorkflow, [kestrel, null, "delta", { subscribe: false }]);
    expect(await sync.returnValue).toMatchObject({ drive: { ran: "delta" } });
    const run = await ingest(path);
    await expect(run.returnValue).rejects.toThrow(/not a readable PDF/);
    expect(await download(run.runId), "a FatalError was turned into something Workflow retries").toMatchObject({
      status: "failed",
      attempt: 1,
    });
  }, 60_000);

  it("retries a download throttled four times after its Retry-After of 1 s, and ingests it on attempt 2", async () => {
    const path = "/Company/Code of Conduct.pdf";
    // The Graph client absorbs three 429s itself; the fourth reaches the step.
    await stack.control("POST", "/faults", {
      site: "kestrel",
      kind: "throttle",
      path_prefix: `/v1.0/sites/kestrel/drive/items/${world.itemId("kestrel", path)}/content`,
      count: 4,
      retry_after_s: 1,
    });
    const run = await ingest(path);
    expect(await run.returnValue, "a 429 should be retried, not fail the ingest").toMatchObject({ status: "ready" });
    expect(await download(run.runId)).toMatchObject({ status: "completed", attempt: 2 });
    expect(await documentAt(path)).toMatchObject({ status: "ready" });
  }, 60_000);
});
