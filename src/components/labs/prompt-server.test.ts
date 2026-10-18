// @vitest-environment node
import { describe, expect, it } from "vitest";

import { inspectTurn } from "./prompt-server";

describe("inspectTurn", () => {
  it("shows Grace's 20 sources of 30 within 6,000 tokens, and her dropped citation", async () => {
    const grace = await inspectTurn("invoice-hold", 30, 6000);
    expect([grace.sources.length, grace.skipped.length, grace.tokens.sources]).toEqual([20, 10, 5984]);
    expect(grace.skipped[0]).toMatchObject({ rank: 19, tokens: 290 });
    expect(grace.verdict).toMatchObject({ flagged: true, dropped: [{ reason: "quote-not-found" }] });
    expect(grace.error).toBeNull();
  });

  it("drops the London reply's S3 citations when only S1 and S2 fit", async () => {
    const london = await inspectTurn("london-hotel", 8, 400);
    expect(london.sources.map((s) => s.label)).toEqual(["S1", "S2"]);
    expect(london.tokens.sources).toBe(368);
    expect(london.verdict?.dropped.map((d) => d.reason)).toEqual(["unknown-source", "unknown-source"]);
  });

  it("shows Leo's Heron abstention and the injection inside S2", async () => {
    const heron = await inspectTurn("heron", 8, 6000);
    expect(heron.verdict).toMatchObject({ abstained: true, flagged: false });
    expect(heron.userTurn).toContain("dataroom@brightwell-diligence.example");
  });
});
