// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Page } from "#learn/parse/types";
import type { Tx } from "@/db/tenant";

import { parse, PDF } from "#learn/parse/parse";
import { pagesToReview, pageText, queueOcrReviews } from "#learn/parse/review";
import { corpusFile, recordedOcr } from "@/core/parse/corpus.test-helpers";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

const typed = (number: number): Page => ({ number, method: "text-layer", blocks: [{ kind: "text", text: "Typed." }] });
const scanned = (number: number, ocrConfidence: number, text = `Page ${number} as OCR read it`): Page => ({
  number,
  method: "ocr",
  ocrConfidence,
  blocks: [{ kind: "text", text }],
});
const numbers = (pages: Page[]) => pages.map((page) => page.number);

const OCR_DOCUMENTS = [
  "eng-incident-bridge-notes-2026-08-17",
  "exec-offsite-notes-2026-09",
  "finance-ap-invoice-batch-b-2026-117",
  "hr-case-note-2026-014",
  "legal-contract-kpc-2026-0142-ashgrove-msa",
  "sales-order-form-marlow-finch",
];
const parsed = (docId: string) => parse(corpusFile(docId).bytes(), PDF, recordedOcr(docId));

describe("pages to review", () => {
  it("never queues a typed page, though it has no confidence at all", () => {
    expect(
      numbers(pagesToReview([typed(1), typed(2), scanned(3, 44.8)])),
      'a text-layer page has no ocrConfidence: check `method` is "ocr" before reading it',
    ).toEqual([3]);
  });

  it("queues OCR'd pages under the threshold: 69.9 waits for a person, 70 is good enough", () => {
    const pages = [scanned(1, 69.9), scanned(2, 70), scanned(3, 88.2), scanned(4, 44.8)];
    expect(numbers(pagesToReview(pages)), "under 70 means < 70, not <= 70").toEqual([1, 4]);
    expect(numbers(pagesToReview(pages, 90))).toEqual([1, 2, 3, 4]);
    expect(numbers(pagesToReview(pages, 0)), "a threshold of 0 turns the queue off").toEqual([]);
  });

  it("has nothing to review in a document without pages", () => {
    expect(pagesToReview(null)).toEqual([]);
  });
});

describe.skipIf(!postgresAvailable)("the review queue", () => {
  let t: TestDatabase;
  let tenant: string;
  let documentId: string;

  const inTenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenantOn(t.appDb, tenant, fn);
  const addDocument = async (externalId: string) => {
    const [{ id }] = await t.sql`
      INSERT INTO documents (tenant_id, source, external_id, title, path, mime_type, version, source_version,
        content_hash, status, acl_version)
      VALUES (${tenant}, 'workspace', ${externalId}, ${externalId}, ${`/${externalId}.pdf`}, ${PDF}, 1, 'v1', 'hash',
        'ready', 1)
      RETURNING id`;
    return id as string;
  };
  const rows = () =>
    t.sql<{ page: number; confidence: number; status: string; ocr_text: string }[]>`
      SELECT page, confidence, status, ocr_text FROM ocr_reviews WHERE document_id = ${documentId} ORDER BY page`;

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: tenant }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
    documentId = await addDocument("made-up-batch");
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("writes one pending row per due page, with its confidence and OCR's text, inside the caller's transaction", async () => {
    const pages = [typed(1), scanned(2, 50.8, "INVOICE\n\nCalder Facilities"), scanned(3, 88.2)];
    await expect(
      inTenant(async (tx) => {
        await queueOcrReviews(tx, { tenantId: tenant, documentId, version: 1 }, pages);
        throw new Error("the chunk write failed");
      }),
    ).rejects.toThrow("the chunk write failed");
    expect(await rows(), "the reviews must roll back with the chunks: write them on `tx`").toEqual([]);

    const queued = await inTenant((tx) => queueOcrReviews(tx, { tenantId: tenant, documentId, version: 1 }, pages));
    expect(queued).toBe(1);
    expect(await rows()).toEqual([{ page: 2, confidence: 50.8, status: "pending", ocr_text: pageText(pages[1]) }]);
  });

  it("queues nothing twice: a retried ingest step adds no row and returns 0", async () => {
    const pages = [scanned(2, 50.8, "INVOICE\n\nCalder Facilities"), scanned(4, 51.1)];
    const again = await inTenant((tx) =>
      queueOcrReviews(tx, { tenantId: tenant, documentId, version: 1 }, pages),
    ).catch((error: Error & { cause?: Error }) => {
      throw new Error(
        `a second run threw "${error.cause?.message ?? error.message}": skip a page that's queued already (onConflictDoNothing)`,
      );
    });
    expect(again, "page 2 is queued already: skip it on conflict, and count only the rows you added").toBe(1);
    const retry = await inTenant((tx) => queueOcrReviews(tx, { tenantId: tenant, documentId, version: 1 }, pages));
    expect(retry).toBe(0);
    expect((await rows()).map((row) => row.page)).toEqual([2, 4]);
  });

  it("queues the six worst pages of the corpus at 70, and none of the handwriting, though it misreads £86m", async () => {
    const due: string[] = [];
    for (const docId of OCR_DOCUMENTS) {
      for (const page of pagesToReview((await parsed(docId)).pages))
        due.push(`${docId} ${page.number} ${page.ocrConfidence}`);
    }
    expect(due).toEqual([
      "finance-ap-invoice-batch-b-2026-117 1 58.4",
      "finance-ap-invoice-batch-b-2026-117 2 50.8",
      "finance-ap-invoice-batch-b-2026-117 3 51.1",
      "legal-contract-kpc-2026-0142-ashgrove-msa 3 44.8",
      "sales-order-form-marlow-finch 1 59.8",
      "sales-order-form-marlow-finch 2 66.6",
    ]);
    const offsite = (await parsed("exec-offsite-notes-2026-09")).pages![0];
    expect(offsite.ocrConfidence).toBe(88.2);
    expect(pageText(offsite)).toContain("Price stays at £36m.");
    expect(corpusFile("exec-offsite-notes-2026-09").source()).toContain("Price stays at £86m.");

    const batch = await parsed("finance-ap-invoice-batch-b-2026-117");
    const id = await addDocument("finance-ap-invoice-batch-b-2026-117");
    expect(
      await inTenant((tx) => queueOcrReviews(tx, { tenantId: tenant, documentId: id, version: 1 }, batch.pages)),
    ).toBe(3);
    const [{ n }] = await t.sql`SELECT count(*)::int AS n FROM ocr_reviews WHERE document_id = ${id}`;
    expect(n).toBe(3);
  });
});
