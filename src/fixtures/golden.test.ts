import { afterAll, beforeAll, describe, expect, it } from "vitest";

// @vitest-environment node
// Checks every golden label against the committed corpus: the page is parsed (OCR'd where it has no text layer,
// about 15 s of tesseract) and must hold the label's evidence, and the asking user must be able to read it.
import type { ParsedDocument } from "#learn/parse/types";

import { parse } from "#learn/parse/parse";
import { Corpus, type CorpusDocument } from "@/fixtures/corpus";
import { loadGolden } from "@/fixtures/golden";
import { loadWorld } from "@/fixtures/world";
import { ocrPng, terminateOcr } from "@/lib/parse/ocr";
import { rasterisePage } from "@/lib/parse/rasterise.server";

const world = loadWorld();
const corpus = new Corpus(world);
const golden = loadGolden();

/** Letters and digits only, lowercased: tables, markdown and OCR all spell the same words differently in between. */
const letters = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const squash = (text: string) => text.replace(/\s+/g, " ").toLowerCase();

const blockText = (doc: Pick<ParsedDocument, "blocks">) =>
  doc.blocks.map((b) => (b.kind === "table" ? b.markdown : b.text)).join("\n");

/** Parsed text per label: the page for a PDF, the whole document otherwise. */
const labelText = new Map<string, string>();
const key = (tenant: string, path: string, page: number | null) => `${tenant}:${path}#${page ?? ""}`;

beforeAll(async () => {
  for (const q of golden) {
    for (const label of q.relevant) {
      const k = key(q.tenant, label.path, label.page);
      if (labelText.has(k)) continue;
      const document = corpus.document(q.tenant, label.path);
      if (!document || (label.page !== null && (document.pages === null || label.page > document.pages))) continue;
      const deps = { rasterise: rasterisePage, ocr: ocrPng };
      const range = label.page === null ? undefined : { pages: { from: label.page, to: label.page } };
      const doc = await parse(corpus.bytes(document), document.mimeType, deps, range);
      labelText.set(k, doc.pages ? doc.pages.map(blockText).join("\n") : blockText(doc));
    }
  }
}, 180_000);

afterAll(async () => {
  await terminateOcr();
});

const answers = golden.filter((q) => q.expect === "answer");
const abstentions = golden.filter((q) => q.expect === "abstain");

describe("the golden set", () => {
  it("has about 40 questions, both outcomes and both tenants", () => {
    expect(golden.length).toBeGreaterThanOrEqual(35);
    expect(golden.length).toBeLessThanOrEqual(50);
    expect(abstentions.length).toBeGreaterThanOrEqual(5);
    expect(new Set(golden.map((q) => q.tenant))).toEqual(new Set(corpus.tenants()));
  });

  it("covers every trap in the corpus", () => {
    const traps = new Set(corpus.tenants().flatMap((t) => corpus.documents(t).flatMap((d) => d.traps)));
    const covered = new Set(golden.flatMap((q) => q.traps));
    expect([...traps].filter((trap) => !covered.has(trap))).toEqual([]);
    expect([...covered].filter((trap) => !traps.has(trap))).toEqual([]);
  });

  it("asks as users in the world", () => {
    for (const q of golden) expect(() => world.user(q.tenant, q.user), q.id).not.toThrow();
  });

  it("labels documents the asker can read, with pages exactly for PDFs", () => {
    for (const q of answers) {
      const readable = corpus.readable(q.tenant, q.user);
      for (const label of q.relevant) {
        const document = corpus.document(q.tenant, label.path);
        expect(document, `${q.id}: ${label.path}`).toBeDefined();
        expect(readable.has(label.path), `${q.id}: ${q.user} can't read ${label.path}`).toBe(true);
        if (document!.pages === null) expect(label.page, `${q.id}: ${label.path} has no pages`).toBeNull();
        else {
          expect(label.page, `${q.id}: ${label.path} needs a page`).not.toBeNull();
          expect(label.page!, `${q.id}: ${label.path}`).toBeLessThanOrEqual(document!.pages);
        }
      }
      const pages = q.relevant.map((label) => `${label.path}#${label.page}`);
      expect(new Set(pages).size, `${q.id} repeats a label`).toBe(pages.length);
    }
  });

  it("finds each label's evidence on its page of the built document", () => {
    for (const q of answers) {
      for (const label of q.relevant) {
        const text = letters(labelText.get(key(q.tenant, label.path, label.page)) ?? "");
        for (const evidence of label.evidence) {
          expect(text.includes(letters(evidence)), `${q.id}: "${evidence}" on ${label.path} p${label.page}`).toBe(true);
        }
      }
    }
  });

  it("hides each abstention's facts from the asker, though the corpus holds them", () => {
    const sources = new Map<CorpusDocument, string>();
    const sourceOf = (document: CorpusDocument) => {
      if (!sources.has(document)) sources.set(document, squash(corpus.source(document)));
      return sources.get(document)!;
    };
    const everything = corpus.tenants().flatMap((t) => corpus.documents(t));
    for (const q of golden) {
      const readable = corpus.readable(q.tenant, q.user);
      const visible = corpus.documents(q.tenant).filter((d) => readable.has(d.path));
      const injection = q.traps.includes("prompt-injection") && q.expect === "answer";
      for (const secret of [...q.hidden, ...q.forbidden]) {
        const needle = squash(secret);
        expect(
          everything.some((d) => sourceOf(d).includes(needle)),
          `${q.id}: "${secret}" isn't in the corpus`,
        ).toBe(true);
        // The injection's address sits in a document everyone can read: that's the trap.
        if (injection) continue;
        const seen = visible.filter((d) => sourceOf(d).includes(needle)).map((d) => d.path);
        expect(seen, `${q.id}: ${q.user} can read "${secret}"`).toEqual([]);
      }
    }
  });

  it("gives peter.hall, who left, nothing to read", () => {
    expect(corpus.readable("kestrel", "peter.hall").size).toBe(0);
    expect(corpus.readable("kestrel", "leo.martin").has("/Exec/Project Heron Board Memo.pdf")).toBe(false);
    expect(corpus.readable("kestrel", "tom.whitfield").has("/Exec/Project Heron Integration Plan v0.4.docx")).toBe(
      true,
    );
  });
});
