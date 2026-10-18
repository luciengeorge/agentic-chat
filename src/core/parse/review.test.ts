// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Tx } from "@/db/tenant";

import { chunk } from "#learn/chunk/chunk";
import { hashingEmbedder } from "#learn/embed/fake";
import { chunks } from "@/db/schema";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import type { ParseDeps } from "./types";

import { corpusFile } from "./corpus.test-helpers";
import { parse, PDF } from "./parse";
import {
  acceptOcrReview,
  correctOcrReview,
  DEFAULT_OCR_REVIEW_THRESHOLD,
  listOcrReviews,
  pagesToReview,
  queueOcrReviews,
  ReviewConflictError,
  spanToRecut,
} from "./review";

const LEO = "c0000000-0000-4000-8000-000000000001";
const NINA = "c0000000-0000-4000-8000-000000000002";

/** What tesseract might make of the MSA's signature page: O for 0, l for i. */
const MISREAD = "Slgned for and on behalf of Ashgrove Lld\n\nKPC-2O26-O142 executed by Prlya Shah";
const CORRECTED = "Signed for and on behalf of Ashgrove Ltd\n\nKPC-2026-0142 executed by Priya Shah";

/** OCR that reads every page as `pages[n]`, at `confidence`. Rasterising is skipped: the PNG carries the number. */
const fakeOcr = (pages: Record<number, string>, confidence: number): ParseDeps => ({
  rasterise: async (_pdf, page) => Uint8Array.of(page),
  ocr: async (png) => ({ text: pages[png[0]] ?? "", confidence }),
});
const noOcr: ParseDeps = {
  rasterise: async () => {
    throw new Error("this test parses text-layer pages only");
  },
  ocr: async () => {
    throw new Error("this test parses text-layer pages only");
  },
};

describe("pagesToReview", () => {
  it("queues OCR'd pages under the threshold, never text-layer pages", () => {
    const page = (number: number, method: "ocr" | "text-layer", ocrConfidence?: number) => ({
      number,
      method,
      ocrConfidence,
      blocks: [],
    });
    const pages = [page(1, "text-layer"), page(2, "ocr", 44.8), page(3, "ocr", 69.9), page(4, "ocr", 88.2)];
    expect(pagesToReview(pages).map((p) => p.number)).toEqual([2, 3]);
    expect(pagesToReview(pages, 50).map((p) => p.number)).toEqual([2]);
    expect(pagesToReview(null)).toEqual([]);
    expect(DEFAULT_OCR_REVIEW_THRESHOLD).toBe(70);
  });
});

describe("spanToRecut", () => {
  const c = (id: string, ordinal: number, page_start: number, page_end: number) => ({
    id,
    ordinal,
    page_start,
    page_end,
  });

  it("takes the chunks holding the page, the pages they reach, and every chunk inside those pages", () => {
    const all = [c("a", 0, 1, 1), c("b", 1, 1, 2), c("c", 2, 2, 2), c("d", 3, 2, 3), c("e", 4, 3, 3), c("f", 5, 4, 4)];
    // d runs from page 2 into 3, so page 2 is cut again too; b crosses in from page 1 and stays.
    expect(spanToRecut(all, 3)).toEqual({ from: 2, to: 3, ids: ["c", "d", "e"] });
    expect(spanToRecut(all, 4)).toEqual({ from: 4, to: 4, ids: ["f"] });
    expect(spanToRecut([], 7)).toEqual({ from: 7, to: 7, ids: [] });
  });
});

describe.skipIf(!postgresAvailable)("the OCR review queue", () => {
  let t: TestDatabase;
  let tenant: string;
  let msa: string;
  let orderForm: string;
  const embedder = hashingEmbedder(1536);

  const inTenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenantOn(t.appDb, tenant, fn);
  const deps = (parseDeps: ParseDeps) => ({
    withTenant: <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => withTenantOn(t.appDb, tenantId, fn),
    embedder,
    parseDeps,
  });
  const chunksOf = (documentId: string) =>
    t.sql<{ id: string; ordinal: number; page_start: number; page_end: number; text: string; model: string | null }[]>`
      SELECT id, ordinal, page_start, page_end, text, embedding_model_version AS model FROM chunks
      WHERE document_id = ${documentId} ORDER BY ordinal`;

  /** What ingest does with a PDF: store it, chunk it, queue its low-confidence pages, mark it ready. */
  async function ingest(docId: string, parseDeps: ParseDeps): Promise<{ id: string; queued: number }> {
    const file = corpusFile(docId);
    const bytes = file.bytes();
    const sha = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
    const parsed = await parse(bytes, PDF, parseDeps);
    return inTenant(async (tx) => {
      await t.sql`
        INSERT INTO document_blobs (tenant_id, sha256, bytes, size, mime_type)
        VALUES (${tenant}, ${sha}, ${Buffer.from(bytes)}, ${bytes.length}, ${PDF})`;
      const [{ id }] = await t.sql`
        INSERT INTO documents (tenant_id, source, external_id, title, path, mime_type, version, source_version,
          content_hash, storage_key, status, acl_version)
        VALUES (${tenant}, 'workspace', ${docId}, ${docId}, ${`/${docId}.pdf`}, ${PDF}, 1, 'v1', ${sha}, ${sha},
          'ready', 1)
        RETURNING id`;
      await t.sql`
        INSERT INTO document_acl (tenant_id, document_id, principal_id, effect, acl_version)
        VALUES (${tenant}, ${id}, ${LEO}, 'allow', 1)`;
      await tx.insert(chunks).values(
        chunk(parsed).map((piece) => ({
          tenantId: tenant,
          documentId: id,
          documentVersion: 1,
          ordinal: piece.ordinal,
          text: piece.text,
          pageStart: piece.pageStart,
          pageEnd: piece.pageEnd,
          section: piece.section,
          tokenCount: piece.tokenCount,
        })),
      );
      const queued = await queueOcrReviews(tx, { tenantId: tenant, documentId: id, version: 1 }, parsed.pages);
      return { id, queued };
    });
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
    const msaIngest = await ingest("legal-contract-kpc-2026-0142-ashgrove-msa", fakeOcr({ 3: MISREAD }, 44.8));
    expect(msaIngest.queued).toBe(1);
    msa = msaIngest.id;
    const orderIngest = await ingest(
      "sales-order-form-marlow-finch",
      fakeOcr({ 1: "Order form OF-2026-0388\n\nMarlow and Flnch Coffee", 2: "Slgned by the customer" }, 59.8),
    );
    expect(orderIngest.queued).toBe(2);
    orderForm = orderIngest.id;
  }, 60_000);

  afterAll(async () => {
    await t?.drop();
  });

  it("queues a low-confidence page without touching its chunks: it stays searchable while pending", async () => {
    const rows = await chunksOf(msa);
    expect(rows.some((row) => row.page_end === 3 && row.text.includes("KPC-2O26-O142"))).toBe(true);
    const reviews = await inTenant((tx) => listOcrReviews(tx, LEO));
    expect(reviews.map((r) => [r.title, r.page, r.confidence, r.status])).toEqual([
      ["legal-contract-kpc-2026-0142-ashgrove-msa", 3, 44.8, "pending"],
      ["sales-order-form-marlow-finch", 1, 59.8, "pending"],
      ["sales-order-form-marlow-finch", 2, 59.8, "pending"],
    ]);
    expect(reviews[0].ocrText).toBe(MISREAD);
  });

  it("shows a reviewer only the reviews of documents they can read", async () => {
    expect(await inTenant((tx) => listOcrReviews(tx, NINA))).toEqual([]);
    const [review] = await inTenant((tx) => listOcrReviews(tx, LEO));
    expect(await inTenant((tx) => acceptOcrReview(tx, NINA, review.id))).toBeNull();
    expect(await correctOcrReview(deps(noOcr), { tenantId: tenant, userId: NINA }, review.id, CORRECTED)).toBeNull();
  });

  it("re-chunks and re-embeds only the corrected page and the neighbour its chunks run into", async () => {
    const before = await chunksOf(msa);
    const [review] = await inTenant((tx) => listOcrReviews(tx, LEO));
    const result = await correctOcrReview(deps(noOcr), { tenantId: tenant, userId: LEO }, review.id, CORRECTED);

    expect(result).toMatchObject({ pages: { from: 2, to: 3 }, review: { status: "corrected", reviewerId: LEO } });
    expect(result!.review.correctedText).toBe(CORRECTED);
    const after = await chunksOf(msa);
    const text = after.map((row) => row.text).join("\n");
    expect(text).not.toContain("KPC-2O26-O142");
    expect(after.find((row) => row.page_end === 3)!.text).toContain("KPC-2026-0142 executed by Priya Shah");

    // Page 1's chunks, and the one crossing from page 1 into 2, are untouched: same ids, same text.
    const kept = before.filter((row) => row.page_start < 2);
    expect(after.filter((row) => row.page_start < 2)).toEqual(kept);
    // The span's chunks are new and embedded; the ordinals still read in page order.
    const fresh = after.filter((row) => row.page_start >= 2);
    expect(fresh.every((row) => row.model === embedder.version)).toBe(true);
    const replaced = new Set(before.filter((row) => row.page_start >= 2).map((row) => row.id));
    expect(fresh.some((row) => replaced.has(row.id))).toBe(false);
    expect(result!.removed).toBe(before.length - kept.length);
    expect(result!.added).toBe(fresh.length);
    const ordinals = after.map((row) => row.ordinal);
    expect(new Set(ordinals).size).toBe(ordinals.length);
    const starts = after.map((row) => row.page_start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));

    await expect(
      correctOcrReview(deps(noOcr), { tenantId: tenant, userId: LEO }, review.id, CORRECTED),
    ).rejects.toBeInstanceOf(ReviewConflictError);
  });

  it("accepts a page as read, and a later correction next to it reuses that page's stored text", async () => {
    const reviews = (await inTenant((tx) => listOcrReviews(tx, LEO))).filter((r) => r.documentId === orderForm);
    const [first, second] = reviews.sort((a, b) => a.page - b.page);
    const before = await chunksOf(orderForm);

    const accepted = await inTenant((tx) => acceptOcrReview(tx, LEO, first.id));
    expect(accepted).toMatchObject({ status: "accepted", reviewerId: LEO, correctedText: null });
    expect(await chunksOf(orderForm)).toEqual(before);
    await expect(inTenant((tx) => acceptOcrReview(tx, LEO, first.id))).rejects.toBeInstanceOf(ReviewConflictError);

    // Both pages are OCR'd: with noOcr, the parse would throw, so page 1 must come from its review row.
    const result = await correctOcrReview(
      deps(noOcr),
      { tenantId: tenant, userId: LEO },
      second.id,
      "Signed by the customer, Marlow and Finch Coffee",
    );
    expect(result!.pages).toEqual({ from: 1, to: 2 });
    const text = (await chunksOf(orderForm)).map((row) => row.text).join("\n");
    expect(text).toContain("Marlow and Flnch Coffee");
    expect(text).toContain("Signed by the customer, Marlow and Finch Coffee");
    expect(text).not.toContain("Slgned");
    expect(await inTenant((tx) => listOcrReviews(tx, LEO))).toEqual([]);
  });
});
