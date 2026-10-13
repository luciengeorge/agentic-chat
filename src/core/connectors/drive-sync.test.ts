// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyDirectory, fetchDirectory } from "#learn/directory/sync";
import { chunks, documentAcl, documents, principals } from "@/db/schema";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { type Client, setupFakeWorkspace } from "../../../servers/fake-workspace/testing";
import { deltaSync, fullSync } from "./drive-sync";
import { createGraphClient, ResyncRequiredError } from "./graph";
import { fetchFrom } from "./testing";

const fw = setupFakeWorkspace();

describe.skipIf(!postgresAvailable)("drive sync", () => {
  let t: TestDatabase;
  let tenant: string;
  let client: Client;

  const graph = () =>
    createGraphClient({
      baseUrl: "http://fw",
      site: "kestrel",
      token: "dev-workspace-kestrel",
      fetch: fetchFrom(client),
      pageSize: 3,
    });
  const inTenant = <T>(fn: Parameters<typeof withTenantOn<T>>[2]) => withTenantOn(t.appDb, tenant, fn);
  const full = () => inTenant((tx) => fullSync(tx, tenant, graph()));
  const delta = (link: string) => inTenant((tx) => deltaSync(tx, tenant, graph(), link));

  async function control(method: string, path: string, json?: unknown) {
    const response = await client.request(method, `/_control/sites/kestrel/items${path}`, { json });
    expect(response.ok, await response.clone().text()).toBe(true);
  }

  async function document(path: string) {
    const [row] = await inTenant((tx) =>
      tx
        .select()
        .from(documents)
        .where(eq(documents.externalId, fw.corpus.id("kestrel", path))),
    );
    return row;
  }

  /** Who a document's ACL names, by principal name. */
  async function aclOf(path: string) {
    const { id } = await document(path);
    const rows = await inTenant((tx) =>
      tx
        .select({ name: principals.name })
        .from(documentAcl)
        .innerJoin(principals, eq(principals.id, documentAcl.principalId))
        .where(eq(documentAcl.documentId, id)),
    );
    return rows.map((row) => row.name).sort();
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
    client = fw.client();
    const snapshot = await fetchDirectory(graph());
    await inTenant((tx) => applyDirectory(tx, tenant, snapshot, new Date()));
  });

  const files = () => fw.corpus.paths("kestrel").filter((path) => /\.[a-z]+$/.test(path));

  it("writes every file as a pending document to ingest, with its effective ACL", async () => {
    const report = await full();
    expect(report).toMatchObject({ files: files().length, created: files().length, deleted: 0, unknownPrincipals: [] });
    expect(report.ingest).toHaveLength(files().length);
    expect(report.deltaLink).toContain("/drive/root/delta?token=");

    const heron = await document("/Exec/Project Heron memo.pdf");
    expect(heron).toMatchObject({
      status: "pending",
      version: 1,
      path: "/Exec/Project Heron memo.pdf",
      source: "workspace",
    });
    expect(heron.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(heron.aclVersion).toBeGreaterThan(0);
    expect(await aclOf("/Exec/Project Heron memo.pdf")).toEqual(["/Kestrel/Exec"]);
    // Own grant plus /Finance's, inherited.
    expect(await aclOf("/Finance/Reports/Q3 report.pdf")).toEqual([
      "/Kestrel/Exec",
      "/Kestrel/Finance",
      "tom.whitfield",
    ]);
    // Inheritance broken: only its own grant.
    expect(await aclOf("/HR/Casework/case note.pdf")).toEqual(["marco.bianchi"]);
  });

  it("changes nothing on a second full sync", async () => {
    await full();
    const [{ last_value }] = await t.sql`SELECT last_value FROM acl_version_seq`;
    const again = await full();
    expect(again).toMatchObject({ created: 0, changed: 0, moved: 0, deleted: 0, aclChanged: 0, ingest: [] });
    expect(await t.sql`SELECT last_value FROM acl_version_seq`).toEqual([{ last_value }]);
  });

  it("ingests a failed document again on the next full sync, though its content hasn't changed", async () => {
    await full();
    const heron = await document("/Exec/Project Heron memo.pdf");
    await inTenant((tx) => tx.update(documents).set({ status: "failed" }).where(eq(documents.id, heron.id)));
    const report = await full();
    expect(report).toMatchObject({ changed: 1, ingest: [{ documentId: heron.id, version: 2 }] });
    expect(await document("/Exec/Project Heron memo.pdf")).toMatchObject({ status: "pending", version: 2 });
  });

  it("applies a rename, a move, a delete, a sharing change and new content from delta", async () => {
    const { deltaLink } = await full();
    const id = (path: string) => fw.corpus.id("kestrel", path);
    const before = await document("/Exec/Project Heron memo.pdf");
    const plan = await document("/Finance/FP&A/plan.md");
    await t.sql`INSERT INTO chunks (tenant_id, document_id, document_version, ordinal, text, token_count)
                VALUES (${tenant}, ${plan.id}, 1, 0, 'plan', 1)`;

    await control("POST", `/${id("/Company/alpha.md")}/rename`, { name: "alpha v2.md" });
    await control("POST", `/${id("/Company/Bravo.md")}/move`, { parent_id: id("/Exec") });
    await control("DELETE", `/${id("/Finance/FP&A/plan.md")}`);
    await control("PUT", `/${id("/Exec/Project Heron memo.pdf")}/sharing`, {
      inherit: true,
      grants: [
        {
          principal_type: "user",
          principal_id: fw.corpus.user("kestrel", "daniel.reyes"),
          principal_name: "daniel.reyes",
          role: "read",
        },
      ],
    });
    await control("PUT", `/${id("/Company/charlie.md")}/content`, {
      content_base64: Buffer.from("new words").toString("base64"),
    });

    const report = await delta(deltaLink);
    expect(report).toMatchObject({ created: 0, deleted: 1, changed: 1 });
    expect(report.moved).toBe(2);

    expect(await document("/Company/alpha.md")).toMatchObject({
      path: "/Company/alpha v2.md",
      title: "alpha v2.md",
      version: 1,
    });
    expect((await document("/Company/Bravo.md")).path).toBe("/Exec/Bravo.md");
    expect(await aclOf("/Company/Bravo.md")).toEqual(["/Kestrel/Exec"]);

    expect(await document("/Finance/FP&A/plan.md")).toMatchObject({ status: "deleted" });
    expect(await aclOf("/Finance/FP&A/plan.md")).toEqual([]);
    expect(await inTenant((tx) => tx.select().from(chunks).where(eq(chunks.documentId, plan.id)))).toEqual([]);

    const heron = await document("/Exec/Project Heron memo.pdf");
    expect(await aclOf("/Exec/Project Heron memo.pdf")).toEqual(["/Kestrel/Exec", "daniel.reyes"]);
    expect(heron.aclVersion).toBeGreaterThan(before.aclVersion);
    expect(heron.version).toBe(1);

    const charlie = await document("/Company/charlie.md");
    expect(charlie).toMatchObject({ version: 2, status: "pending" });
    expect(report.ingest).toEqual([{ documentId: charlie.id, version: 2 }]);

    expect(await delta(report.deltaLink)).toMatchObject({ files: 0, deleted: 0, ingest: [] });
  });

  it("re-paths a renamed folder's files, which delta doesn't list", async () => {
    const { deltaLink } = await full();
    await control("POST", `/${fw.corpus.id("kestrel", "/Finance/Reports")}/rename`, { name: "Reporting" });
    const report = await delta(deltaLink);
    expect((await document("/Finance/Reports/Q3 report.pdf")).path).toBe("/Finance/Reporting/Q3 report.pdf");
    expect(report.ingest).toEqual([]);
  });

  it("says to resync when the delta link has expired", async () => {
    const { deltaLink } = await full();
    expect((await client.request("POST", "/_control/reset")).status).toBe(200);
    await expect(delta(deltaLink)).rejects.toBeInstanceOf(ResyncRequiredError);
  });

  it("deletes documents a full sync no longer finds", async () => {
    await full();
    await control("DELETE", `/${fw.corpus.id("kestrel", "/HR/Casework")}`);
    // A full sync from scratch, as after a resync: no delta involved.
    const report = await full();
    expect(report.deleted).toBe(1);
    expect(await document("/HR/Casework/case note.pdf")).toMatchObject({ status: "deleted" });
  });
});
