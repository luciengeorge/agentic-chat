// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fullSync } from "#learn/connectors/drive-sync";
import { createGraphClient, graphConnector } from "#learn/connectors/graph";
import { applyDirectory, fetchDirectory } from "#learn/directory/sync";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { createApp, DEFAULT_CORPUS_DIR } from "../../servers/fake-workspace/app";
import { checkIngestion, type SmokeTargets } from "./smoke";

const WORKSPACE_URL = "http://fw";

describe.skipIf(!postgresAvailable)("checkIngestion", () => {
  let t: TestDatabase;
  const { app } = createApp({ env: "dev" });
  const fetch = async (url: string, init?: RequestInit) => app.fetch(new Request(url, init));
  const target = (): SmokeTargets => ({
    databaseUrl: t.appUrl,
    appUrl: "http://app",
    workspaceUrl: WORKSPACE_URL,
    corpusDir: DEFAULT_CORPUS_DIR,
    fetch,
  });

  beforeAll(async () => {
    t = await createTestDatabase();
    const tenants = await t.sql<{ id: string; slug: string }[]>`
      INSERT INTO organization (name, slug, created_at)
      VALUES ('Kestrel Pay', 'kestrel', now()), ('Harbour Health', 'harbour', now())
      RETURNING id, slug`;
    for (const { id, slug } of tenants) {
      const graph = createGraphClient({ baseUrl: WORKSPACE_URL, site: slug, token: `dev-workspace-${slug}`, fetch });
      const snapshot = await fetchDirectory(graph);
      await withTenantOn(t.appDb, id, async (tx) => {
        await applyDirectory(tx, id, snapshot, new Date());
        await fullSync(tx, id, graphConnector(graph));
      });
    }
  }, 60_000);

  beforeEach(async () => {
    await t.sql`UPDATE documents SET status = 'ready'`;
    await t.sql`DELETE FROM chunks`;
    await t.sql`INSERT INTO chunks (tenant_id, document_id, document_version, ordinal, text, token_count)
                SELECT tenant_id, id, version, 0, 'text', 1 FROM documents`;
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("passes when every file is a ready document with chunks and an ACL, and the Heron memo is Exec's only", async () => {
    expect(await checkIngestion(target())).toBe(
      "harbour 6 ready (6 chunks), kestrel 40 ready (40 chunks); /Exec/Project Heron Board Memo.pdf's ACL: /Kestrel/Exec only",
    );
  });

  it("fails on a document that isn't ready", async () => {
    await t.sql`UPDATE documents SET status = 'failed' WHERE path = '/Company/Office Guide.pdf'`;
    await expect(checkIngestion(target())).rejects.toThrow("kestrel: not ready: /Company/Office Guide.pdf (failed)");
  });

  it("fails on a document with no chunks", async () => {
    await t.sql`DELETE FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE path = '/Sales/Pricing FAQ.pdf')`;
    await expect(checkIngestion(target())).rejects.toThrow("kestrel: no chunks or no ACL: /Sales/Pricing FAQ.pdf");
  });

  it("fails when the Heron memo reaches anyone but /Kestrel/Exec", async () => {
    await t.sql`
      INSERT INTO document_acl (tenant_id, document_id, principal_id, effect, acl_version)
      SELECT d.tenant_id, d.id, p.id, 'allow', d.acl_version FROM documents d, principals p
      WHERE d.path = '/Exec/Project Heron Board Memo.pdf' AND p.name = 'leo.martin'`;
    try {
      await expect(checkIngestion(target())).rejects.toThrow(
        "holds [/Kestrel/Exec, leo.martin], want /Kestrel/Exec only",
      );
    } finally {
      await t.sql`DELETE FROM document_acl WHERE principal_id IN (SELECT id FROM principals WHERE name = 'leo.martin')`;
    }
  });

  it("fails on a live document the drive no longer has", async () => {
    await t.sql`
      INSERT INTO documents (tenant_id, source, external_id, title, path, mime_type, version, source_version,
        content_hash, status, acl_version)
      SELECT id, 'workspace', 'gone', 'Gone', '/Gone.md', 'text/markdown', 1, 'v', 'x', 'ready', 1
      FROM organization WHERE slug = 'harbour'`;
    try {
      await expect(checkIngestion(target())).rejects.toThrow("harbour: /Gone.md live but gone from the drive");
    } finally {
      await t.sql`DELETE FROM documents WHERE external_id = 'gone'`;
    }
  });
});
