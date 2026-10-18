// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Connector } from "#learn/connectors/types";

import { deltaSync, fullSync } from "#learn/connectors/drive-sync";
import { createGraphClient, type GraphClient } from "#learn/connectors/graph";
import { changesFor, graphConnector } from "#learn/connectors/graph-connector";
import { applyDirectory, fetchDirectory } from "#learn/directory/sync";
import { KESTREL_TOKEN, REAL_BASE_URL, type RealWorkspace, setupRealWorkspace } from "@/core/connectors/testing";
import { chunks, documentAcl, documentBlobs, documents, principals } from "@/db/schema";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

const workspace = setupRealWorkspace();
const INVOICES = "/Finance/AP/AP Batch B-2026-117 Scanned Invoices.pdf";
const REPORTS = [
  "/Finance/Reports/Management Accounts August 2026.pdf",
  "/Finance/Reports/Q3 2026 Quarterly Report.pdf",
];
const CHECKLIST = "/Finance/Month-End Close Checklist.md";

describe.skipIf(!postgresAvailable)("deletes and moves", () => {
  let t: TestDatabase;
  let tenant: string;
  let fw: RealWorkspace;
  let graph: GraphClient;
  let source: Connector;

  const inTenant = <T>(fn: Parameters<typeof withTenantOn<T>>[2]) => withTenantOn(t.appDb, tenant, fn);
  const full = () => inTenant((tx) => fullSync(tx, tenant, source));
  const delta = (cursor: string) => inTenant((tx) => deltaSync(tx, tenant, source, cursor));
  const items = (path: string) => `/sites/kestrel/items/${fw.id(path)}`;
  const document = async (path: string) =>
    (
      await inTenant((tx) =>
        tx
          .select()
          .from(documents)
          .where(eq(documents.externalId, fw.id(path))),
      )
    )[0];
  const aclOf = async (path: string) => {
    const { id } = await document(path);
    const rows = await inTenant((tx) =>
      tx
        .select({ name: principals.name })
        .from(documentAcl)
        .innerJoin(principals, eq(principals.id, documentAcl.principalId))
        .where(eq(documentAcl.documentId, id)),
    );
    return rows.map((row) => row.name).sort();
  };
  const chunksOf = async (path: string) => {
    const { id } = await document(path);
    return inTenant((tx) => tx.select().from(chunks).where(eq(chunks.documentId, id)));
  };

  /** What ingestion would have left: two chunks, and the blob. */
  async function ingested(path: string) {
    const doc = await document(path);
    await t.sql`INSERT INTO chunks (tenant_id, document_id, document_version, ordinal, text, token_count)
                VALUES (${tenant}, ${doc.id}, 1, 0, 'Invoice 1', 2), (${tenant}, ${doc.id}, 1, 1, 'Invoice 2', 2)`;
    const bytes = Buffer.from("scanned invoices");
    await t.sql`INSERT INTO document_blobs (tenant_id, sha256, bytes, size, mime_type)
                VALUES (${tenant}, ${doc.contentHash}, ${bytes}, ${bytes.length}, 'application/pdf')
                ON CONFLICT DO NOTHING`;
    return doc;
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: tenant }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
  });

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    await t.sql`DELETE FROM documents`;
    await t.sql`DELETE FROM document_blobs`;
    fw = workspace.start();
    graph = createGraphClient({ baseUrl: REAL_BASE_URL, site: "kestrel", token: KESTREL_TOKEN, fetch: fw.fetch });
    source = graphConnector(graph);
    const snapshot = await fetchDirectory(graph);
    await inTenant((tx) => applyDirectory(tx, tenant, snapshot, new Date()));
  });

  it("takes a deleted file out of search at once: its chunks and ACL go, and it's marked deleted", async () => {
    const { cursor } = await full();
    const before = await ingested(INVOICES);
    expect(await chunksOf(INVOICES)).toHaveLength(2);
    await fw.control("DELETE", items(INVOICES));

    const report = await delta(cursor);
    expect(report.deleted).toBe(1);
    expect(await document(INVOICES)).toMatchObject({ status: "deleted", deletedAt: expect.any(Date) });
    expect(await chunksOf(INVOICES), "search reads chunks: delete them, or the assistant keeps quoting it").toEqual([]);
    expect(await aclOf(INVOICES), "nobody may read a document that's gone").toEqual([]);
    const blobs = await inTenant((tx) =>
      tx.select().from(documentBlobs).where(eq(documentBlobs.sha256, before.contentHash)),
    );
    expect(blobs, "leave the blob: the file may come back, or share its bytes").toHaveLength(1);
  });

  it("counts a delete once, though it arrives twice", async () => {
    const { cursor } = await full();
    await fw.control("DELETE", items(INVOICES));
    expect((await delta(cursor)).deleted).toBe(1);
    // A crash before the new cursor was saved: the same delta, tombstone and all, is read again.
    expect((await delta(cursor)).deleted, "an already deleted document is nothing to do").toBe(0);
    expect((await full()).deleted, "nor is it for a full sync's sweep").toBe(0);
  });

  it("deletes, on a full sync, what the source no longer has", async () => {
    await full();
    await fw.control("DELETE", items("/Finance/Reports"));
    const report = await full();
    expect(report.deleted, "the folder's two reports went with it").toBe(2);
    for (const path of REPORTS) expect((await document(path)).status).toBe("deleted");
  });

  it("re-paths a renamed folder's files, which delta doesn't list: same documents, nothing to ingest", async () => {
    const { cursor } = await full();
    const ids = await Promise.all(REPORTS.map(async (path) => (await document(path)).id));
    await fw.control("POST", `${items("/Finance/Reports")}/rename`, { name: "Board Reports" });

    const entries = (await graph.delta(cursor)).changes;
    expect(
      entries.map((e) => e.id),
      "Graph's delta names the folder, not the files in it",
    ).toContain(fw.id("/Finance/Reports"));
    expect(entries.map((e) => e.id)).not.toContain(fw.id(REPORTS[0]));

    const report = await delta(cursor);
    expect(report, "crawl the folder again: each file at its new path").toMatchObject({
      files: 2,
      moved: 2,
      ingest: [],
    });
    expect((await document(REPORTS[0])).path).toBe("/Finance/Board Reports/Management Accounts August 2026.pdf");
    expect(await Promise.all(REPORTS.map(async (path) => (await document(path)).id))).toEqual(ids);
  });

  it("moves a file into another folder's sharing: same document, new path, new ACL", async () => {
    const { cursor } = await full();
    expect(await aclOf(CHECKLIST)).toEqual(["/Kestrel/Finance", "tom.whitfield"]);
    await fw.control("POST", `${items(CHECKLIST)}/move`, { parent_id: fw.id("/Exec") });
    const report = await delta(cursor);
    expect(report).toMatchObject({ files: 1, moved: 1, aclChanged: 1, ingest: [] });
    expect(await document(CHECKLIST)).toMatchObject({ path: "/Exec/Month-End Close Checklist.md", version: 1 });
    expect(await aclOf(CHECKLIST), "it now inherits /Exec's grant").toEqual(["/Kestrel/Exec"]);
  });

  it("skips a file deleted between the delta and the read, and never makes the root a document", async () => {
    const { cursor } = await full();
    await fw.control("POST", `${items(CHECKLIST)}/rename`, { name: "Checklist.md" });
    const { changes } = await graph.delta(cursor);
    expect(changes.map((e) => e.id)).toEqual([fw.id(CHECKLIST)]);

    await fw.control("DELETE", items(CHECKLIST));
    expect(
      await changesFor(graph, changes[0]),
      "gone by the time you read it (404): skip it, the tombstone comes in the next delta",
    ).toEqual([]);
    const root = await graph.item("root");
    expect(await changesFor(graph, root), "the root isn't a document").toEqual([]);
    const forbidden = createGraphClient({
      baseUrl: REAL_BASE_URL,
      site: "kestrel",
      token: "dev-workspace-harbour",
      fetch: fw.fetch,
    });
    await expect(
      changesFor(forbidden, { ...changes[0], id: fw.id(INVOICES) }),
      "only a 404 is skipped: a 403 is a real failure",
    ).rejects.toMatchObject({ status: 403 });
  });
});
