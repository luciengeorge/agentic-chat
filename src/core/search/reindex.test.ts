// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { chunks, documents } from "@/db/schema";
import { type Tx, withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { lexicalSearch } from "./lexical";
import {
  BM25_INDEX,
  bm25Indexes,
  beginTokenizerChange,
  bm25IndexSql,
  buildBm25IndexConcurrently,
  compareFields,
  fieldExpression,
  finishTokenizerChange,
  LEXICAL_V1,
  LEXICAL_V2,
  replaceBm25Index,
} from "./reindex";

describe("bm25IndexSql", () => {
  it("writes the column's own field plainly and every other field as an alias", () => {
    expect(fieldExpression(LEXICAL_V1)).toBe(
      "(text::pdb.unicode_words('stemmer=english','stopwords_language=english'))",
    );
    expect(fieldExpression({ name: "text_simple", tokenizer: { name: "simple", args: [] } })).toBe(
      "(text::pdb.simple('alias=text_simple'))",
    );
    expect(bm25IndexSql("next_idx", [LEXICAL_V1], { concurrently: true })).toBe(
      "CREATE INDEX CONCURRENTLY next_idx ON chunks USING paradedb " +
        "(id, (text::pdb.unicode_words('stemmer=english','stopwords_language=english')), tenant_id, document_id)",
    );
  });

  it("refuses names that would need quoting, and fields that repeat", () => {
    expect(() => bm25IndexSql("x; DROP TABLE chunks", [LEXICAL_V1])).toThrow(RangeError);
    expect(() => bm25IndexSql("x", [LEXICAL_V1, LEXICAL_V1])).toThrow(RangeError);
  });
});

describe.skipIf(!postgresAvailable)("changing the tokenizer without downtime", () => {
  let t: TestDatabase;
  let tenantId: string;
  const documentId = randomUUID();
  const TEXTS = [
    "Contract KPC-2026-0142 with Ashgrove renews automatically.",
    "The 2026 budget plan for the payments team.",
    "Running the settlement job at night.",
  ];
  const inTenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenantOn(t.appDb, tenantId, fn);
  const search = (query: string, field?: string) =>
    inTenant(async (tx) => {
      const hits = await lexicalSearch(tx, query, { documentIds: [documentId], limit: 10, field });
      const rows = await t.sql<{ id: string; text: string }[]>`SELECT id, text FROM chunks`;
      return hits.map((hit) => rows.find((row) => row.id === hit.id)!.text);
    });

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: tenantId }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel', 'kestrel', now()) RETURNING id`;
    await t.db.insert(documents).values({
      id: documentId,
      tenantId,
      source: "test",
      externalId: documentId,
      title: "t",
      path: "/t",
      mimeType: "text/markdown",
      version: 1,
      sourceVersion: "1",
      contentHash: "x",
      status: "ready",
    });
    await t.db
      .insert(chunks)
      .values(
        TEXTS.map((text, ordinal) => ({ tenantId, documentId, documentVersion: 1, ordinal, text, tokenCount: 8 })),
      );
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("builds the transition index beside the old one, cuts over by field, then drops the old field", async () => {
    // v1 splits the contract number, so a search for the year finds the contract too.
    const before = await search("2026");
    expect(before).toHaveLength(2);
    expect(await bm25Indexes(t.db)).toEqual([BM25_INDEX]);

    // A plain CREATE INDEX of a second BM25 index is refused; a concurrent build isn't.
    await expect(t.sql.unsafe(bm25IndexSql("chunks_bm25_next", [LEXICAL_V1], { concurrently: false }))).rejects.toThrow(
      /only have one ParadeDB index/,
    );
    await buildBm25IndexConcurrently(t.db, "chunks_bm25_next", [LEXICAL_V1, LEXICAL_V2]);
    expect(await bm25Indexes(t.db)).toEqual([BM25_INDEX, "chunks_bm25_next"]);

    // The new index serves now, and the old field answers exactly as before: nobody noticed the build.
    expect(await search("2026")).toEqual(before);
    expect(await search("running")).toEqual(["Running the settlement job at night."]);

    await replaceBm25Index(t.db, BM25_INDEX, "chunks_bm25_next");
    expect(await bm25Indexes(t.db)).toEqual([BM25_INDEX]);

    // Dual read: the same queries on both fields. v2 keeps the identifier whole, so "2026" loses the contract.
    const [year, contract] = await inTenant((tx) =>
      compareFields(tx, ["2026", "KPC-2026-0142"], {
        from: LEXICAL_V1.name,
        to: LEXICAL_V2.name,
        documentIds: [documentId],
        limit: 10,
      }),
    );
    expect(year.from).toHaveLength(2);
    expect(year.to).toHaveLength(1);
    expect(year.overlap).toBe(0.5);
    expect(contract.to).toHaveLength(1);

    // The cutover is the field search reads; stemming still works on v2.
    expect(await search("2026", LEXICAL_V2.name)).toEqual(["The 2026 budget plan for the payments team."]);
    expect(await search("kpc-2026-0142", LEXICAL_V2.name)).toEqual([TEXTS[0]]);
    expect(await search("runs", LEXICAL_V2.name)).toEqual([TEXTS[2]]);

    // Last, an index with only the new field. Rows written meanwhile are in it.
    await t.db.insert(chunks).values({
      tenantId,
      documentId,
      documentVersion: 1,
      ordinal: 3,
      text: "Another 2026 note.",
      tokenCount: 3,
    });
    await buildBm25IndexConcurrently(t.db, "chunks_bm25_next", [LEXICAL_V2]);
    await replaceBm25Index(t.db, BM25_INDEX, "chunks_bm25_next");
    expect(await search("2026", LEXICAL_V2.name)).toEqual(
      expect.arrayContaining(["The 2026 budget plan for the payments team.", "Another 2026 note."]),
    );
    expect(await search("2026", LEXICAL_V2.name)).toHaveLength(2);
  });

  it("begins and finishes a change in one call each, and the old field answers the same until the switch", async () => {
    // The index now holds v2 alone; change it to a plain lowercase split, under an alias of its own.
    const simple = { name: "text_simple", tokenizer: { name: "simple", args: [] } };
    const before = await search("2026", LEXICAL_V2.name);
    await expect(beginTokenizerChange(t.db, LEXICAL_V2, { ...simple, name: LEXICAL_V2.name })).rejects.toThrow(
      RangeError,
    );
    await beginTokenizerChange(t.db, LEXICAL_V2, simple);
    expect(await bm25Indexes(t.db)).toEqual([BM25_INDEX]);
    expect(await search("2026", LEXICAL_V2.name)).toEqual(before);
    // simple splits the identifier, so the year finds the contract again; it doesn't stem.
    expect(await search("2026", simple.name)).toHaveLength(3);
    expect(await search("runs", simple.name)).toEqual([]);
    await finishTokenizerChange(t.db, simple);
    expect(await bm25Indexes(t.db)).toEqual([BM25_INDEX]);
    expect(await search("2026", simple.name)).toHaveLength(3);
  });
});
