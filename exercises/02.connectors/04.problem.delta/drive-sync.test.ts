// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Connector } from "#learn/connectors/types";

import { deltaSync, fullSync } from "#learn/connectors/drive-sync";
import { createGraphClient, ResyncRequiredError } from "#learn/connectors/graph";
import { graphConnector } from "#learn/connectors/graph-connector";
import { applyDirectory, fetchDirectory } from "#learn/directory/sync";
import {
  KESTREL_TOKEN,
  REAL_BASE_URL,
  type RealWorkspace,
  serveReceiver,
  setupRealWorkspace,
} from "@/core/connectors/testing";
import { documentAcl, documents, principals } from "@/db/schema";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

const workspace = setupRealWorkspace();
const BUDGET = "/Finance/FP&A/FY2026 Budget Notes and Assumptions.docx";
const CHECKLIST = "/Finance/Month-End Close Checklist.md";
const PLAN = "/Exec/Project Heron Integration Plan v0.4.docx";

describe.skipIf(!postgresAvailable)("full and delta sync", () => {
  let t: TestDatabase;
  let tenant: string;
  let fw: RealWorkspace;
  let source: Connector;

  const inTenant = <T>(fn: Parameters<typeof withTenantOn<T>>[2]) => withTenantOn(t.appDb, tenant, fn);
  const full = (from: Connector = source) => inTenant((tx) => fullSync(tx, tenant, from));
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
    fw = workspace.start();
    const graph = createGraphClient({ baseUrl: REAL_BASE_URL, site: "kestrel", token: KESTREL_TOKEN, fetch: fw.fetch });
    source = graphConnector(graph);
    const snapshot = await fetchDirectory(graph);
    await inTenant((tx) => applyDirectory(tx, tenant, snapshot, new Date()));
  });

  it("writes all 40 files as pending documents to ingest, each with its ACL", async () => {
    const report = await full();
    expect(report).toMatchObject({ files: 40, created: 40, changed: 0, moved: 0, unknownPrincipals: [] });
    expect(report.ingest).toHaveLength(40);
    expect(report.cursor, "the report's cursor is where the next delta starts").toContain("/drive/root/delta?token=");
    expect(await document(PLAN)).toMatchObject({ status: "pending", version: 1, path: PLAN });
    expect(await aclOf(PLAN)).toEqual(["/Kestrel/Exec", "tom.whitfield"]);
  });

  it("changes nothing on a second full sync", async () => {
    await full();
    expect(await full()).toMatchObject({ files: 40, created: 0, changed: 0, moved: 0, aclChanged: 0, ingest: [] });
  });

  it("takes the cursor before the crawl, so a file changed during it is in the next delta", async () => {
    // Tom replaces the budget notes once the crawl has passed Finance.
    let crawled = 0;
    const busy: Connector = {
      ...source,
      async *crawl() {
        for await (const page of source.crawl()) {
          yield page;
          crawled += page.length;
          if (page.some((file) => file.path === BUDGET)) {
            await fw.control("PUT", `${items(BUDGET)}/content`, {
              content_base64: Buffer.from("FY2026 budget, revised").toString("base64"),
            });
          }
        }
      },
    };
    const report = await full(busy);
    expect(crawled).toBe(40);
    expect((await document(BUDGET)).version, "the crawl read the budget before Tom's upload").toBe(1);

    const next = await delta(report.cursor);
    expect(
      next.ingest,
      "take latestCursor() before the crawl: a cursor taken after it starts after Tom's upload",
    ).toEqual([{ documentId: (await document(BUDGET)).id, version: 2 }]);
  });

  it("applies a rename, new content and a sharing change from delta, and hands back where to read next", async () => {
    const { cursor } = await full();
    await fw.control("POST", `${items(CHECKLIST)}/rename`, { name: "Month-End Close Checklist (Oct).md" });
    await fw.control("PUT", `${items(BUDGET)}/content`, { content_base64: Buffer.from("v2").toString("base64") });
    await fw.control("PUT", `${items(PLAN)}/sharing`, { inherit: true, grants: [] });

    const report = await delta(cursor);
    expect(report).toMatchObject({ files: 3, created: 0, moved: 1, changed: 1, aclChanged: 1 });
    expect(report.cursor, "the delta hands back a new cursor: return it, not the one you were given").not.toBe(cursor);
    expect(await document(CHECKLIST)).toMatchObject({
      path: "/Finance/Month-End Close Checklist (Oct).md",
      version: 1,
    });
    expect(await aclOf(PLAN), "Tom's own grant is gone; /Exec's stays").toEqual(["/Kestrel/Exec"]);

    expect(await delta(report.cursor), "nothing changed since the new cursor").toMatchObject({ files: 0, ingest: [] });
  });

  it("lets an expired cursor's ResyncRequiredError reach the caller", async () => {
    const { cursor } = await full();
    await fw.control("POST", "/reset");
    const outcome = await delta(cursor).then(
      () => "no error",
      (error: unknown) => error,
    );
    expect(outcome, "don't catch it: the caller runs a full sync instead").toBeInstanceOf(ResyncRequiredError);
  });

  it("gets a webhook that names no file, and finds the change with a delta", async () => {
    const receiver = await serveReceiver();
    try {
      const { cursor } = await full();
      const subscription = await source.subscribe({
        notificationUrl: receiver.url,
        clientState: "kestrel-secret",
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await fw.control("POST", `${items(CHECKLIST)}/rename`, { name: "Close Checklist.md" });
      await fw.control("POST", "/flush");

      expect(receiver.notifications).toHaveLength(1);
      const [notification] = receiver.notifications[0].value;
      expect(notification).toMatchObject({ subscriptionId: subscription.id, clientState: "kestrel-secret" });
      expect(JSON.stringify(notification), "a notification says 'look again', never what changed").not.toContain(
        fw.id(CHECKLIST),
      );

      const report = await delta(cursor);
      expect(report).toMatchObject({ files: 1, moved: 1 });
      expect((await document(CHECKLIST)).path).toBe("/Finance/Close Checklist.md");
    } finally {
      await receiver.close();
    }
  });
});
