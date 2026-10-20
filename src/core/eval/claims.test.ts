// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { CitableSource } from "#learn/cite/citations";

import { checkClaims, citedLabels, decomposeClaims, scoreClaims } from "#learn/eval/claims";
import { scriptedObjects } from "#learn/model/testing";

const source = (label: string, text: string): CitableSource => ({
  label,
  chunkId: `chunk-${label}`,
  documentId: `doc-${label}`,
  title: `Doc ${label}`,
  path: `/Docs/${label}.md`,
  pageStart: null,
  pageEnd: null,
  text,
});

const SOURCES = [
  source("S1", "| Hotel, London | £180 a night |"),
  source("S2", "Version 2.0 (from 1 July 2026): Hotel, London £200 a night."),
];

describe("citedLabels", () => {
  it("lists each label the answer cites once, in order of first use", () => {
    expect(citedLabels('A [[S2: "x x x x x"]] b [[S1: "y y y y"]] c [[S2: "z z z z"]]')).toEqual(["S2", "S1"]);
  });
});

describe("decomposeClaims", () => {
  it("returns the model's claims, and drops any label the answer never cited", async () => {
    const { model, mock } = scriptedObjects([
      {
        claims: [
          { text: "Version 2 sets the London hotel limit at £200 a night.", sources: ["S2", "S7"] },
          { text: "Version 1 set it at £180.", sources: [] },
        ],
      },
    ]);
    const { claims } = await decomposeClaims(
      model,
      { question: "London hotel limit?", answer: 'It is £200 [[S2: "Hotel, London £200 a night"]], once £180.' },
      "low",
    );
    expect(claims).toEqual([
      { text: "Version 2 sets the London hotel limit at £200 a night.", sources: ["S2"] },
      { text: "Version 1 set it at £180.", sources: [] },
    ]);
    expect(JSON.stringify(mock.doGenerateCalls[0].prompt)).toContain("atomic claims");
  });
});

describe("checkClaims", () => {
  const claims = [
    { text: "Version 2 sets the London hotel limit at £200 a night.", sources: ["S2"] },
    { text: "The limit covers the minibar.", sources: [] },
  ];

  it("shows each claim the sources it cited, or all of them when it cited none", async () => {
    const { model, mock } = scriptedObjects([
      {
        checks: [
          { claim: 1, verdict: "supported", evidence: "Hotel, London £200 a night" },
          { claim: 2, verdict: "not_found", evidence: null },
        ],
      },
    ]);
    const { checked } = await checkClaims(model, { claims, sources: SOURCES }, "low");
    const prompt = JSON.stringify(mock.doGenerateCalls[0].prompt);
    expect(prompt).toContain("1. Version 2 sets the London hotel limit at £200 a night. (sources: S2)");
    expect(prompt).toContain("2. The limit covers the minibar. (sources: S1, S2)");
    expect(checked.map((c) => [c.verdict, c.uncited])).toEqual([
      ["supported", false],
      ["not_found", true],
    ]);
  });

  it("counts a claim the model skipped as not found", async () => {
    const { model } = scriptedObjects([{ checks: [{ claim: 1, verdict: "supported", evidence: "x" }] }]);
    const { checked } = await checkClaims(model, { claims, sources: SOURCES }, "low");
    expect(checked[1]).toMatchObject({ verdict: "not_found", evidence: null });
  });

  it("makes no call for an answer with no claims (an abstention)", async () => {
    const { model, mock } = scriptedObjects([]);
    expect(await checkClaims(model, { claims: [], sources: SOURCES }, "low")).toEqual({ checked: [], usage: null });
    expect(mock.doGenerateCalls).toHaveLength(0);
  });
});

describe("scoreClaims", () => {
  it("scores the share of claims supported, so one wrong number in four claims is 0.75", () => {
    const claim = (verdict: "supported" | "contradicted" | "not_found", uncited = false) => ({
      text: "x",
      sources: [],
      verdict,
      evidence: null,
      uncited,
    });
    expect(
      scoreClaims([claim("supported"), claim("supported", true), claim("supported"), claim("contradicted")]),
    ).toEqual({
      claims: 4,
      supported: 3,
      contradicted: 1,
      notFound: 0,
      uncited: 1,
      faithfulness: 0.75,
    });
    expect(scoreClaims([]).faithfulness).toBe(1);
  });
});
