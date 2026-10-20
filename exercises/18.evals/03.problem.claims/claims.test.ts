// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { CitableSource } from "#learn/cite/citations";

import {
  type CheckedClaim,
  checkClaims,
  checkMessage,
  type ClaimVerdict,
  decomposeClaims,
  scoreClaims,
} from "#learn/eval/claims";
import { scriptedObjects } from "#learn/model/testing";
import { loadJudgeSet } from "@/core/eval/judge-set";
import { replayEvalModel } from "@/core/eval/recorded";

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
  source("S3", "Meals: £45 a day."),
];

const CLAIMS = [
  { text: "Version 2 sets the London hotel limit at £200 a night.", sources: ["S2"] },
  { text: "The limit covers the minibar.", sources: [] },
];

describe("checkMessage", () => {
  it("numbers the claims from 1, each with the sources it cited, or every source when it cited none", () => {
    const message = checkMessage(CLAIMS, SOURCES);
    expect(message, "a claim that cited S2 is checked against S2 alone").toContain(
      "1. Version 2 sets the London hotel limit at £200 a night. (sources: S2)",
    );
    expect(message, "an uncited claim may use every source: list all the labels").toContain(
      "2. The limit covers the minibar. (sources: S1, S2, S3)",
    );
  });

  it("puts the sources, rendered as the answer's prompt rendered them, before the claims", () => {
    const message = checkMessage(CLAIMS, SOURCES);
    expect(message.startsWith('<sources>\n<source id="S1"'), "start with <sources> and S1's block").toBe(true);
    expect(message).toContain("£200 a night.");
    expect(message.indexOf("</sources>")).toBeLessThan(message.indexOf("<claims>"));
    expect(message.endsWith("\n</claims>")).toBe(true);
  });
});

describe("checkClaims", () => {
  it("checks every claim in one call named claim_checks, and matches the checks back by number", async () => {
    const { model, mock } = scriptedObjects([
      {
        checks: [
          { claim: 2, verdict: "not_found", evidence: null },
          { claim: 1, verdict: "supported", evidence: "Hotel, London £200 a night" },
        ],
      },
    ]);
    const { checked } = await checkClaims(model, { claims: CLAIMS, sources: SOURCES }, "low");
    expect(mock.doGenerateCalls, "one call for all the claims").toHaveLength(1);
    expect(mock.doGenerateCalls[0].responseFormat).toMatchObject({ type: "json", name: "claim_checks" });
    expect(JSON.stringify(mock.doGenerateCalls[0].prompt)).toContain("You check claims against sources");
    expect(
      checked.map((c) => [c.text, c.verdict, c.evidence]),
      "the reply answered claim 2 first: match each check by its `claim` number, not by its place",
    ).toEqual([
      [CLAIMS[0].text, "supported", "Hotel, London £200 a night"],
      [CLAIMS[1].text, "not_found", null],
    ]);
  });

  it("marks a claim that cited nothing as uncited, and keeps each claim's own sources", async () => {
    const { model } = scriptedObjects([
      {
        checks: [
          { claim: 1, verdict: "supported", evidence: "x" },
          { claim: 2, verdict: "supported", evidence: "y" },
        ],
      },
    ]);
    const { checked } = await checkClaims(model, { claims: CLAIMS, sources: SOURCES }, "low");
    expect(checked.map((c) => [c.sources, c.uncited])).toEqual([
      [["S2"], false],
      [[], true],
    ]);
  });

  it("counts a claim the checker skipped as not found, with no evidence", async () => {
    const { model } = scriptedObjects([{ checks: [{ claim: 1, verdict: "supported", evidence: "x" }] }]);
    const { checked } = await checkClaims(model, { claims: CLAIMS, sources: SOURCES }, "low");
    expect(checked, "two claims in, two out: claim 2 had no check").toHaveLength(2);
    expect(checked[1], "silence is no evidence: not_found").toMatchObject({ verdict: "not_found", evidence: null });
  });

  it("makes no call for an answer with no claims", async () => {
    const { model, mock } = scriptedObjects([]);
    expect(await checkClaims(model, { claims: [], sources: SOURCES }, "low")).toEqual({ checked: [], usage: null });
    expect(mock.doGenerateCalls, "an abstention has nothing to check").toHaveLength(0);
  });
});

describe("scoreClaims", () => {
  const claim = (verdict: ClaimVerdict, uncited = false): CheckedClaim => ({
    text: "x",
    sources: [],
    verdict,
    evidence: null,
    uncited,
  });

  it("counts each verdict, and scores the share supported", () => {
    expect(
      scoreClaims([claim("supported"), claim("supported", true), claim("supported", true), claim("contradicted")]),
    ).toEqual({ claims: 4, supported: 3, contradicted: 1, notFound: 0, uncited: 2, faithfulness: 0.75 });
  });

  it("counts a claim the sources don't back against the answer, as a contradicted one is", () => {
    expect(
      scoreClaims([claim("supported"), claim("not_found")]).faithfulness,
      "not_found is a claim the sources don't make: it isn't supported",
    ).toBe(0.5);
  });

  it("scores an answer with no claims 1: it says nothing false", () => {
    expect(scoreClaims([])).toEqual({
      claims: 0,
      supported: 0,
      contradicted: 0,
      notFound: 0,
      uncited: 0,
      faithfulness: 1,
    });
  });
});

describe("the 20 hand-labelled answers, replayed", () => {
  const set = loadJudgeSet();

  async function claimsFor(id: string) {
    const item = set.find((i) => i.id === id)!;
    const model = replayEvalModel("claims", id);
    const { claims } = await decomposeClaims(model, item, "low");
    const { checked } = await checkClaims(model, { claims, sources: item.sources }, "medium");
    return { item, checked, score: scoreClaims(checked) };
  }

  it("finds the wrong sum in Grace's invoice answer: 4 claims, 3 supported, faithfulness 0.75", async () => {
    const { checked, score } = await claimsFor("invoice-arithmetic");
    expect(checked.map((c) => [c.verdict, c.uncited])).toEqual([
      ["supported", false],
      ["supported", true],
      ["contradicted", true],
      ["supported", true],
    ]);
    expect(checked[2].text).toContain("£800");
    expect(checked[2].evidence).toContain("£80.00");
    expect(score).toMatchObject({ claims: 4, supported: 3, contradicted: 1, uncited: 3, faithfulness: 0.75 });
  });

  it("makes 48 claims over the 19 answers that make one (2.53 each), and scores faithful answers 1.00, unfaithful 0.55", async () => {
    const results: Awaited<ReturnType<typeof claimsFor>>[] = [];
    for (const item of set) results.push(await claimsFor(item.id));
    const abstention = results.find((r) => r.item.id === "heron-recorded")!;
    expect(abstention.checked, "Heron's abstention claims nothing (the recording has no check call for it)").toEqual(
      [],
    );
    const withClaims = results.filter((r) => r.score.claims > 0);
    expect(withClaims).toHaveLength(19);
    expect(withClaims.reduce((n, r) => n + r.score.claims, 0)).toBe(48);
    const meanOf = (label: string) => {
      const scores = results.filter((r) => r.item.label === label).map((r) => r.score.faithfulness);
      return scores.reduce((a, b) => a + b, 0) / scores.length;
    };
    expect(meanOf("faithful")).toBe(1);
    expect(meanOf("unfaithful")).toBeCloseTo(0.549, 3);
    const missed = results
      .filter((r) => (r.score.faithfulness === 1 ? "faithful" : "unfaithful") !== r.item.label)
      .map((r) => r.item.id);
    expect(missed, "faithful only when every claim is supported: one answer gets past it").toEqual([
      "london-old-limit",
    ]);
  });
});
