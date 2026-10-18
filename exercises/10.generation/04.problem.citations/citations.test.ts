// @vitest-environment node
import { describe, expect, it } from "vitest";

import { normalizeForMatch, quoteInText, validateCitations, type CitableSource } from "#learn/cite/citations";
import { buildPrompt } from "#learn/generate/prompt";
import { APP_K, recordedReply, recordedTurn } from "@/core/generate/recorded";

const source = (label: string, text: string, pageStart: number | null = 2): CitableSource => ({
  label,
  chunkId: `chunk-${label}`,
  documentId: `doc-${label}`,
  title: `Doc ${label}`,
  path: `/HR/Policies/${label}.pdf`,
  pageStart,
  pageEnd: pageStart,
  text,
});

const V2 = source(
  "S1",
  "## 4. Limits\n\n| Item | Limit |\n| --- | --- |\n| Hotel, London | £200 a night |\n\nMeals are **£40** a day.",
  2,
);
const V1 = source("S2", "| Hotel, London | £180 a night |", 3);
const reasons = (text: string, sources = [V2, V1]) => validateCitations(text, sources).dropped.map((d) => d.reason);

describe("finding a quote", () => {
  it("matches through case, markdown emphasis, table pipes and spacing", () => {
    expect(quoteInText("hotel, london £200 a night", V2.text), "normalise the quote and the text the same way").toBe(
      true,
    );
    expect(quoteInText("Meals are £40 a day", V2.text)).toBe(true);
    expect(quoteInText("Hotel, London | £200   a night", V2.text)).toBe(true);
  });

  it("matches an elided quote piece by piece, in order only", () => {
    expect(quoteInText("Hotel, London … Meals are £40", V2.text), "split on the ellipsis, find each piece").toBe(true);
    expect(quoteInText("Hotel, London ... Meals are £40", V2.text)).toBe(true);
    expect(
      quoteInText("Meals are £40 … Hotel, London", V2.text),
      "search for each piece after the last one ended: these two are the wrong way round",
    ).toBe(false);
  });

  it("doesn't find what isn't there", () => {
    expect(quoteInText("Hotel, London £250 a night", V2.text)).toBe(false);
  });
});

describe("validating citations", () => {
  it("keeps a citation of a source the model saw whose quote is in it, with where to open it", () => {
    const report = validateCitations('London is £200 [[S1: "Hotel, London | £200 a night"]].', [V2, V1]);
    expect(report).toEqual({
      citations: [
        {
          marker: '[[S1: "Hotel, London | £200 a night"]]',
          label: "S1",
          quote: "Hotel, London | £200 a night",
          chunkId: "chunk-S1",
          documentId: "doc-S1",
          title: "Doc S1",
          path: "/HR/Policies/S1.pdf",
          page: 2,
        },
      ],
      dropped: [],
      flagged: false,
    });
  });

  it("checks a quote against the source it names, not against every source", () => {
    expect(
      reasons('London was £180 [[S1: "Hotel, London | £180 a night"]].'),
      "that quote is S2's: pinned to S1 it would open the wrong page",
    ).toEqual(["quote-not-found"]);
  });

  it("drops a label no source has, a marker with no quote, and one it can't read", () => {
    expect(reasons('£200 [[S9: "Hotel, London | £200 a night"]].')).toEqual(["unknown-source"]);
    expect(reasons("£200 [[S1]].")).toEqual(["no-quote"]);
    expect(reasons('£200 [[see the policy: "Hotel, London"]].')).toEqual(["malformed"]);
    expect(validateCitations("£200 [[S9]].", [V2]).dropped[0], "the label is kept when there is one").toEqual({
      marker: "[[S9]]",
      label: "S9",
      reason: "unknown-source",
    });
  });

  it("drops a quote under 8 characters, counted after normalising", () => {
    expect(reasons('[[S1: "£40"]]'), "3 characters prove nothing").toEqual(["quote-too-short"]);
    expect(
      reasons('[[S1: "**£40**"]]'),
      "7 raw characters, but 3 once the stars go: measure normalizeForMatch(quote), not the raw quote",
    ).toEqual(["quote-too-short"]);
    expect(reasons('[[S1: "| £200 |"]]'), "8 raw characters, 4 without the pipes and spaces: too short").toEqual([
      "quote-too-short",
    ]);
    expect(normalizeForMatch("£40 a day")).toHaveLength(9);
    expect(reasons('[[S1: "£40 a day"]]'), "9 characters: long enough, and in S1").toEqual([]);
  });

  it("flags a report with a dropped citation, or with nothing kept", () => {
    expect(validateCitations('A [[S1: "Hotel, London | £200 a night"]] B [[S9: "x y z w v u"]]', [V2]).flagged).toBe(
      true,
    );
    expect(validateCitations("London is £200 a night.", [V2]), "an answer citing nothing is flagged").toMatchObject({
      citations: [],
      dropped: [],
      flagged: true,
    });
  });
});

describe("Grace's invoice answer", () => {
  it("keeps two of her three citations and drops the one that tidied the OCR", () => {
    const grace = recordedTurn("invoice-hold");
    const { sources } = buildPrompt({ question: grace.question, chunks: grace.chunks.slice(0, APP_K) });
    const report = validateCitations(recordedReply("invoice-hold"), sources);

    expect(report.citations.map((c) => c.quote)).toEqual([
      "The difference is £80.00 plus VAT (2,000 packs at £0.04)",
      "Pay only against a credit note or a corrected invoice.",
    ]);
    expect(report.citations[0]).toMatchObject({
      label: "S1",
      path: "/Finance/AP/AP Batch B-2026-117 Scanned Invoices.pdf",
      page: 1,
    });
    expect(report.dropped).toEqual([
      {
        marker: '[[S1: "charged £1.62 a welcome pack; the PO and contract KPC-2025-0204 say £1.58"]]',
        label: "S1",
        reason: "quote-not-found",
      },
    ]);
    expect(report.flagged).toBe(true);
    // The scan reads "KPC-2025-0204 2 ; ‘say £1.58": OCR noise the model left out of its quote.
    expect(normalizeForMatch(sources[0].text)).toContain("kpc-2025-0204 2 ; 'say £1.58");
  });
});
