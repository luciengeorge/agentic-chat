import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRun, start } from "workflow/api";
import { getWorld } from "workflow/runtime";

import { relayOnce } from "@/db/outbox";
import { postgresAvailable } from "@/db/testing";
import { loadWorld } from "@/fixtures/world";
import { type AgentRuntime, setAgentRuntime } from "@/lib/agent-runtime";
import { deliver } from "@/server/plugins/relay-deliver";

import { ingestWorkflow } from "./ingest";
import { ORDINALS_PER_RANGE } from "./ingest-deps";
import { failIngest } from "./ingest-steps";
import { type Stack, startStack } from "./ingest-testing";
import { syncWorkflow } from "./sync";

const world = loadWorld();
const KESTREL_FILES = 40;

describe.skipIf(!postgresAvailable)("sync and ingest workflows", () => {
  let stack: Stack;
  let kestrel: string;

  const documentAt = async (path: string) => {
    const [row] = await stack.t.sql`
      SELECT id, version, status, storage_key, content_hash, path FROM documents
      WHERE external_id = ${world.itemId("kestrel", path)}`;
    return row;
  };
  const outboxFor = async (documentId: string) => {
    const [row] = await stack.t.sql`
      SELECT id FROM outbox WHERE kind = 'ingest' AND payload->>'documentId' = ${documentId}
      ORDER BY created_at DESC LIMIT 1`;
    return row.id as string;
  };
  const ingest = async (path: string, options = {}) => {
    const document = await documentAt(path);
    const run = await start(ingestWorkflow, [
      kestrel,
      document.id,
      document.version,
      await outboxFor(document.id),
      options,
    ]);
    return { run, document, result: await run.returnValue };
  };
  const chunksOf = (documentId: string) =>
    stack.t
      .sql`SELECT ordinal, page_start, page_end, text FROM chunks WHERE document_id = ${documentId} ORDER BY ordinal`;

  /** Chunks by embedding model version (NULL when not embedded) and dimensions. */
  const embeddingsOf = async (documentId: string) =>
    (
      await stack.t.sql`
        SELECT embedding_model_version AS version, vector_dims(embedding) AS dims, count(*)::int AS n
        FROM chunks WHERE document_id = ${documentId} GROUP BY 1, 2`
    ).map((row) => ({ ...row }));

  beforeAll(async () => {
    stack = await startStack();
    kestrel = stack.tenants.kestrel;
  }, 60_000);

  afterAll(async () => {
    await stack?.close();
  });

  it("syncs a tenant in full: directory, documents with ACLs, an ingest row each, and a subscription", async () => {
    const run = await start(syncWorkflow, [kestrel, null, "full"]);
    const result = await run.returnValue;
    expect(result).toMatchObject({
      status: "synced",
      directory: { principals: world.tenant("kestrel").users.length + world.tenant("kestrel").groups.length },
      drive: { ran: "full", files: KESTREL_FILES, created: KESTREL_FILES, ingest: KESTREL_FILES },
      subscription: { renewed: false },
    });
    const [{ n }] = await stack.t
      .sql`SELECT count(*)::int AS n FROM outbox WHERE kind = 'ingest' AND tenant_id = ${kestrel}`;
    expect(n).toBe(KESTREL_FILES);

    const heron = await documentAt("/Exec/Project Heron Board Memo.pdf");
    const acl = await stack.t.sql`
      SELECT p.name FROM document_acl a JOIN principals p ON p.id = a.principal_id WHERE a.document_id = ${heron.id}`;
    expect(acl).toEqual([{ name: "/Kestrel/Exec" }]);

    const [state] = await stack.t.sql`SELECT subscription_id, client_state_hash, delta_token FROM sync_state`;
    expect(state.subscription_id).toBeTruthy();
    expect(state.client_state_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stack.workspace.runtime.notifier.subscriptions.size).toBe(1);
  }, 60_000);

  it("subscribes again when fake-workspace has forgotten the subscription", async () => {
    const [before] = await stack.t.sql`SELECT subscription_id FROM sync_state WHERE tenant_id = ${kestrel}`;
    // What a restart or a reset does to fake-workspace's subscriptions.
    await stack.workspace.runtime.notifier.reset();
    const run = await start(syncWorkflow, [kestrel, null, "delta"]);
    expect(await run.returnValue).toMatchObject({ subscription: { renewed: false } });
    const [after] = await stack.t.sql`SELECT subscription_id FROM sync_state WHERE tenant_id = ${kestrel}`;
    expect(after.subscription_id).not.toBe(before.subscription_id);
    expect([...stack.workspace.runtime.notifier.subscriptions.keys()]).toEqual([after.subscription_id]);

    const again = await start(syncWorkflow, [kestrel, null, "delta"]);
    expect(await again.returnValue).toMatchObject({
      subscription: { subscriptionId: after.subscription_id, renewed: true },
    });
  }, 60_000);

  it("renews only the drive's subscription row", async () => {
    const other = new Date("2030-01-01T00:00:00Z");
    await stack.t.sql`
      INSERT INTO sync_state (tenant_id, connector, scope, subscription_id, subscription_expires_at)
      VALUES (${kestrel}, 'workspace', 'mail', 'sub-mail', ${other.toISOString()}::timestamptz)`;
    try {
      const run = await start(syncWorkflow, [kestrel, null, "delta"]);
      expect(await run.returnValue).toMatchObject({ subscription: { renewed: true } });
      const [mail] = await stack.t.sql`
        SELECT subscription_expires_at FROM sync_state WHERE tenant_id = ${kestrel} AND scope = 'mail'`;
      expect(new Date(mail.subscription_expires_at)).toEqual(other);
    } finally {
      await stack.t.sql`DELETE FROM sync_state WHERE scope = 'mail'`;
    }
  }, 60_000);

  it("ingests markdown, docx and a text PDF: blob stored, chunks written, ready", async () => {
    for (const path of [
      "/Finance/Month-End Close Checklist.md",
      "/Finance/AP/Supplier Payment Run Procedure.docx",
      "/Exec/Project Heron Board Memo.pdf",
    ]) {
      const { document, result } = await ingest(path);
      expect(result, path).toMatchObject({ status: "ready" });
      expect(result.chunks, path).toBeGreaterThan(0);
      const after = await documentAt(path);
      expect(after).toMatchObject({ status: "ready", storage_key: document.content_hash });
      const [blob] = await stack.t
        .sql`SELECT size, octet_length(bytes) AS length FROM document_blobs WHERE sha256 = ${after.storage_key}`;
      expect(blob.size).toBe(blob.length);
      const rows = await chunksOf(document.id);
      expect(rows).toHaveLength(result.chunks);
      if (path.endsWith(".pdf")) expect(rows.every((row) => row.page_start >= 1)).toBe(true);
      else expect(rows.every((row) => row.page_start === null)).toBe(true);
      expect(await embeddingsOf(document.id), path).toEqual([
        { version: "fake-hashing-v1@1536", dims: 1536, n: result.chunks },
      ]);
    }
  }, 60_000);

  it("stops a second run for the same outbox row", async () => {
    const document = await documentAt("/Company/new-starter-checklist.md");
    const outboxId = await outboxFor(document.id);
    const first = await start(ingestWorkflow, [kestrel, document.id, 1, outboxId]);
    expect(await first.returnValue).toMatchObject({ status: "ready" });
    const second = await start(ingestWorkflow, [kestrel, document.id, 1, outboxId]);
    expect(await second.returnValue).toEqual({ status: "duplicate", chunks: 0 });
  }, 60_000);

  it("keeps a document ready when firing its drive-change automations fails", async () => {
    const path = "/Company/2026 Holiday Calendar.pdf";
    const broken = {
      transaction: async () => {
        throw new Error("automations unreachable");
      },
    } as unknown as AgentRuntime["db"];
    setAgentRuntime({ db: broken, loop: () => ({}) as never });
    try {
      const { result } = await ingest(path);
      expect(result).toMatchObject({ status: "ready" });
    } finally {
      setAgentRuntime(null);
    }
    expect(await documentAt(path)).toMatchObject({ status: "ready" });
  }, 60_000);

  it("never marks a ready version failed", async () => {
    const path = "/Finance/Month-End Close Checklist.md";
    const document = await documentAt(path);
    expect(document.status).toBe("ready");
    await failIngest(kestrel, document.id, document.version, "late failure");
    expect(await documentAt(path)).toMatchObject({ status: "ready" });
  });

  it("fans a long PDF out to child runs by page range, numbering chunks per range", async () => {
    const path = "/Finance/Reports/Q3 2026 Quarterly Report.pdf";
    const { run, document, result } = await ingest(path, { fanOutPages: 3, rangePages: 2 });
    expect(result).toMatchObject({ status: "ready" });
    const rows = await chunksOf(document.id);
    expect(rows).toHaveLength(result.chunks);
    // 7 pages in ranges of 2: four children, chunk ordinals start at 0, 100000, 200000 and 300000.
    const ranges = [...new Set(rows.map((row) => Math.floor(row.ordinal / ORDINALS_PER_RANGE)))];
    expect(ranges).toEqual([0, 1, 2, 3]);
    // Embedded once every range is in, before the document is ready.
    expect(await embeddingsOf(document.id)).toEqual([{ version: "fake-hashing-v1@1536", dims: 1536, n: rows.length }]);
    for (const row of rows) {
      const index = Math.floor(row.ordinal / ORDINALS_PER_RANGE);
      expect(row.page_start).toBeGreaterThanOrEqual(index * 2 + 1);
      expect(row.page_end).toBeLessThanOrEqual(index * 2 + 2);
    }
    const children = await (await getWorld()).runs.list({ workflowName: undefined, resolveData: "none" } as never);
    const childRuns = children.data.filter((r) => r.workflowName.includes("ingestRangeWorkflow"));
    expect(childRuns.length).toBeGreaterThanOrEqual(4);
    expect(await getRun(run.runId).status).toBe("completed");
  }, 60_000);

  it("OCRs a scanned PDF through the page routes", async () => {
    const { document, result } = await ingest("/Sales/OF-2026-0388 Marlow and Finch Coffee signed.pdf");
    expect(result).toMatchObject({ status: "ready" });
    const text = (await chunksOf(document.id)).map((row) => row.text).join("\n");
    expect(text).toMatch(/Marlow/i);
  }, 120_000);

  it("fails a document whose bytes can't be parsed, without retrying", async () => {
    const path = "/Company/Office Guide.pdf";
    const before = await documentAt(path);
    const response = await stack.control("PUT", `/sites/kestrel/items/${world.itemId("kestrel", path)}/content`, {
      content_base64: Buffer.from("not a pdf").toString("base64"),
    });
    expect(response.status).toBe(200);
    const sync = await start(syncWorkflow, [kestrel, null, "delta", { subscribe: false }]);
    expect(await sync.returnValue).toMatchObject({ drive: { ran: "delta", changed: 1, ingest: 1 } });

    const document = await documentAt(path);
    expect(document.version).toBe(before.version + 1);
    const run = await start(ingestWorkflow, [kestrel, document.id, document.version, await outboxFor(document.id)]);
    await expect(run.returnValue).rejects.toThrow(/not a readable PDF/);
    expect(await documentAt(path)).toMatchObject({ status: "failed" });
    const steps = await (await getWorld()).steps.list({ runId: run.runId, resolveData: "none" } as never);
    const store = steps.data.find((step) => step.stepName.endsWith("storeBlob"))!;
    expect(store).toMatchObject({ status: "failed", attempt: 1 });
  }, 60_000);

  it("retries a throttled download after Retry-After, then ingests", async () => {
    const path = "/Company/Code of Conduct.pdf";
    const document = await documentAt(path);
    // The client absorbs three 429s itself; the fourth reaches the step, which retries after Retry-After.
    await stack.control("POST", "/faults", {
      site: "kestrel",
      kind: "throttle",
      path_prefix: `/v1.0/sites/kestrel/drive/items/${world.itemId("kestrel", path)}/content`,
      count: 4,
      retry_after_s: 1,
    });
    const run = await start(ingestWorkflow, [kestrel, document.id, document.version, await outboxFor(document.id)]);
    expect(await run.returnValue).toMatchObject({ status: "ready" });
    const steps = await (await getWorld()).steps.list({ runId: run.runId, resolveData: "none" } as never);
    expect(steps.data.find((step) => step.stepName.endsWith("storeBlob"))).toMatchObject({
      status: "completed",
      attempt: 2,
    });
  }, 60_000);

  it("relays outbox rows to runs, and a change arrives by webhook as a delta sync", async () => {
    // Rows the earlier tests didn't use: the relay starts their ingests, which find the work done or do it.
    await stack.t.sql`UPDATE outbox SET published_at = now() WHERE kind = 'ingest'`;
    const path = "/Sales/Pricing FAQ.pdf";
    const response = await stack.control("POST", `/sites/kestrel/items/${world.itemId("kestrel", path)}/rename`, {
      name: "Pricing FAQ 2026.pdf",
    });
    expect(response.status).toBe(200);
    // fake-workspace posts the notification to the stand-in webhook, which queues a delta sync.
    await stack.workspace.runtime.notifier.flush();
    const [queued] = await stack.t.sql`SELECT id FROM outbox WHERE kind = 'sync' AND published_at IS NULL`;
    expect(queued).toBeDefined();

    const relayed = await relayOnce(stack.t.db, deliver);
    expect(relayed.published).toContain(queued.id);
    const run = (await (await getWorld()).runs.list({ resolveData: "none" } as never)).data.find(
      (r) => r.workflowName.includes("syncWorkflow") && r.status !== "completed",
    );
    if (run) await getRun(run.runId).returnValue;
    await expect
      .poll(async () => (await documentAt(path)).path, { timeout: 20_000 })
      .toBe("/Sales/Pricing FAQ 2026.pdf");
    const [claimed] = await stack.t.sql`SELECT claimed_by FROM outbox WHERE id = ${queued.id}`;
    expect(claimed.claimed_by).toMatch(/^wrun_/);
  }, 60_000);
});
