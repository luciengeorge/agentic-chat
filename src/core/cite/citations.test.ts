import { describe, expect, it } from "vitest";

import { normalizeForMatch, parseCitations, validateCitations, type CitableSource } from "./citations";

const source = (label: string, text: string, overrides: Partial<CitableSource> = {}): CitableSource => ({
  label,
  chunkId: `chunk-${label}`,
  documentId: `doc-${label}`,
  title: `Doc ${label}`,
  path: `/Kestrel/Policies/${label}.md`,
  pageStart: null,
  pageEnd: null,
  text,
  ...overrides,
});

const POLICY = source(
  "S1",
  "# Expenses policy v2\n\nMeals while travelling are reimbursed up to **£45** per day.\n\n| Item | Limit |\n| --- | --- |\n| Hotel | £180 |",
  { pageStart: 3, pageEnd: 3 },
);

describe("parseCitations", () => {
  it("finds every marker with its label, quote and position", () => {
    const text = 'Meals are capped [[S1: "reimbursed up to £45 per day"]]. Hotels too [[S2: "Hotel £180"]].';
    expect(parseCitations(text)).toEqual([
      {
        marker: '[[S1: "reimbursed up to £45 per day"]]',
        label: "S1",
        quote: "reimbursed up to £45 per day",
        index: 17,
      },
      { marker: '[[S2: "Hotel £180"]]', label: "S2", quote: "Hotel £180", index: 68 },
    ]);
  });

  it("parses a marker with no quote as one, so it can be rejected", () => {
    expect(parseCitations("See [[S1]].")).toEqual([{ marker: "[[S1]]", label: "S1", quote: null, index: 4 }]);
  });
});

describe("normalizeForMatch", () => {
  it("ignores case, markdown emphasis, table pipes, curly quotes and runs of whitespace", () => {
    expect(normalizeForMatch("Reimbursed up to **£45**\n per   day")).toBe("reimbursed up to £45 per day");
    expect(normalizeForMatch("| Hotel | £180 |")).toBe("hotel £180");
    expect(normalizeForMatch("the “policy’s” limit")).toBe('the "policy\'s" limit');
  });
});

describe("validateCitations", () => {
  it("keeps a citation whose label is a source and whose quote is in that source's text", () => {
    const report = validateCitations('Up to £45 a day [[S1: "reimbursed up to £45 per day"]].', [POLICY]);
    expect(report.flagged).toBe(false);
    expect(report.dropped).toEqual([]);
    expect(report.citations).toEqual([
      expect.objectContaining({
        label: "S1",
        chunkId: "chunk-S1",
        documentId: "doc-S1",
        page: 3,
        quote: "reimbursed up to £45 per day",
      }),
    ]);
  });

  it("matches a quote across a table row and markdown bold", () => {
    expect(validateCitations('[[S1: "Hotel | £180"]]', [POLICY]).citations).toHaveLength(1);
    expect(validateCitations('[[S1: "up to £45 per day"]]', [POLICY]).citations).toHaveLength(1);
  });

  it("drops a made-up citation: a label that names no retrieved chunk", () => {
    const report = validateCitations('Up to £45 [[S9: "reimbursed up to £45 per day"]].', [POLICY]);
    expect(report.citations).toEqual([]);
    expect(report.dropped).toEqual([expect.objectContaining({ label: "S9", reason: "unknown-source" })]);
    expect(report.flagged).toBe(true);
  });

  it("drops a citation whose quote isn't in the chunk it names", () => {
    const report = validateCitations('Up to £60 [[S1: "reimbursed up to £60 per day"]].', [POLICY]);
    expect(report.dropped).toEqual([expect.objectContaining({ label: "S1", reason: "quote-not-found" })]);
    expect(report.flagged).toBe(true);
  });

  it("drops a citation with no quote, or one too short to prove anything", () => {
    const report = validateCitations('A [[S1]] and B [[S1: "£45"]].', [POLICY]);
    expect(report.dropped.map((d) => d.reason)).toEqual(["no-quote", "quote-too-short"]);
  });

  it("accepts an elided quote when each piece is in the chunk, in order", () => {
    expect(validateCitations('[[S1: "Meals while travelling … £45 per day"]]', [POLICY]).citations).toHaveLength(1);
    expect(validateCitations('[[S1: "£45 per day ... Meals while travelling"]]', [POLICY]).dropped).toHaveLength(1);
  });

  it("flags an answer that cites nothing", () => {
    expect(validateCitations("The limit is £45.", [POLICY])).toMatchObject({ flagged: true, citations: [] });
  });
});
