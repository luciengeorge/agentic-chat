// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Tx } from "@/db/tenant";

import { PDF } from "#learn/parse/parse";
import { tableBlock } from "#learn/parse/tables";
import { corpusFile, recordedOcr } from "@/core/parse/corpus.test-helpers";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { tableCells } from "./parsing-blocks";
import { type ParsingLabDeps, parsedPage, queueDocumentReviews } from "./parsing-server";

const LEO = "c0000000-0000-4000-8000-000000000001";
const NINA = "c0000000-0000-4000-8000-000000000002";

describe("tableCells", () => {
  it("reads a table block's markdown back into rows, empty and escaped cells included", () => {
    const block = tableBlock([
      ["Code", "Retry", "Note"],
      ["KP-1009", "", "a | b"],
    ]);
    expect(tableCells(block.markdown)).toEqual([
      ["Code", "Retry", "Note"],
      ["KP-1009", "", "a | b"],
    ]);
  });
});

describe.skipIf(!postgresAvailable)("the parsing lab", () => {
  let t: TestDatabase;
  let tenant: string;
  const ids = new Map<string, string>();

  const deps = (docId: string): ParsingLabDeps => ({
    withTenant: <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => withTenantOn(t.appDb, tenantId, fn),
    parseDeps: recordedOcr(docId),
    threshold: 70,
  });
  const leo = () => ({ tenantId: tenant, userId: LEO });

  /** A stored, ready document that only Leo can read. */
  async function store(docId: string) {
    const file = corpusFile(docId);
    const bytes = file.bytes();
    const sha = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
    await t.sql`
      INSERT INTO document_blobs (tenant_id, sha256, bytes, size, mime_type)
      VALUES (${tenant}, ${sha}, ${Buffer.from(bytes)}, ${bytes.length}, ${file.mimeType})`;
    const [{ id }] = await t.sql`
      INSERT INTO documents (tenant_id, source, external_id, title, path, mime_type, version, source_version,
        content_hash, storage_key, status, acl_version)
      VALUES (${tenant}, 'workspace', ${docId}, ${docId}, ${`/${docId}`}, ${file.mimeType}, 1, 'v1', ${sha}, ${sha},
        'ready', 1)
      RETURNING id`;
    await t.sql`
      INSERT INTO document_acl (tenant_id, document_id, principal_id, effect, acl_version)
      VALUES (${tenant}, ${id}, ${LEO}, 'allow', 1)`;
    ids.set(docId, id);
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: tenant }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
    for (const [id, name] of [
      [LEO, "leo.martin"],
      [NINA, "nina.osei"],
    ]) {
      await t.sql`
        INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, enabled, synced_at)
        VALUES (${id}, ${tenant}, 'user', ${id}, ${name}, ${name}, true, now())`;
    }
    await store("legal-contract-kpc-2026-0142-ashgrove-msa");
    await store("finance-month-end-close-checklist");
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  });

  it("shows a typed page from its text layer, and the scanned page by OCR, due for review", async () => {
    const msa = "legal-contract-kpc-2026-0142-ashgrove-msa";
    const typed = await parsedPage(deps(msa), leo(), ids.get(msa)!, 2);
    expect(typed).toMatchObject({ mimeType: PDF, page: 2, pages: 3, method: "text-layer", dueForReview: false });
    expect(typed.blocks.some((block) => block.kind === "heading" && block.text === "9. Liability")).toBe(true);
    const signed = await parsedPage(deps(msa), leo(), ids.get(msa)!, 3);
    expect(signed).toMatchObject({ page: 3, method: "ocr", confidence: 44.8, dueForReview: true, error: null });
    expect((await parsedPage(deps(msa), leo(), ids.get(msa)!, 9)).page, "a page past the end shows the last").toBe(3);
  });

  it("shows a markdown file whole, with no pages", async () => {
    const md = "finance-month-end-close-checklist";
    const whole = await parsedPage(deps(md), leo(), ids.get(md)!, null);
    expect(whole).toMatchObject({ page: null, pages: null, method: null, error: null });
    expect(whole.blocks.length).toBeGreaterThan(3);
  });

  it("refuses a document the viewer can't read", async () => {
    const msa = "legal-contract-kpc-2026-0142-ashgrove-msa";
    await expect(parsedPage(deps(msa), { tenantId: tenant, userId: NINA }, ids.get(msa)!, 1)).rejects.toThrow(
      "can't read it",
    );
  });

  it("queues the MSA's signature page once, at the document's current version", async () => {
    const msa = "legal-contract-kpc-2026-0142-ashgrove-msa";
    expect(await queueDocumentReviews(deps(msa), leo(), ids.get(msa)!)).toEqual({
      queued: 1,
      ocrPages: 1,
      error: null,
    });
    expect(await queueDocumentReviews(deps(msa), leo(), ids.get(msa)!)).toEqual({
      queued: 0,
      ocrPages: 1,
      error: null,
    });
    expect(await t.sql`SELECT page, confidence, document_version FROM ocr_reviews`).toEqual([
      { page: 3, confidence: 44.8, document_version: 1 },
    ]);
  });
});
