// @vitest-environment node
import { describe, expect, it } from "vitest";

import { DEFAULT_CAPS } from "#learn/agent/caps";

import { stepThroughRun } from "./loop-server";

describe("the loop lab", () => {
  it("steps through Grace's run: 11 decisions, the caps growing to 7,257 tokens", async () => {
    const lab = await stepThroughRun("kpc-terms");
    expect(lab.steps.map((s) => s.decision)).toEqual([
      "model",
      "tools",
      "model",
      "tools",
      "model",
      "tools",
      "model",
      "approval",
      "tools",
      "model",
      "finish",
    ]);
    expect(lab.steps[2].turn).toMatchObject({
      inputTokens: 1949,
      calls: [{ tool: "search_documents" }, { tool: "find_person" }],
    });
    expect(lab.steps[0].turn?.planning).toBe(true);
    expect(lab.steps.at(-1)).toMatchObject({ finish: { status: "succeeded" }, usage: { modelTurns: 5, tokens: 7257 } });
    expect(lab.events).toBe(lab.recordedEvents);
  });

  it("stops at a tighter cap before the mail goes", async () => {
    const lab = await stepThroughRun("kpc-terms", { ...DEFAULT_CAPS, tokens: 7000 });
    expect(lab.steps.at(-1)).toMatchObject({
      decision: "finish",
      finish: { status: "failed", reason: "cap reached: 7000 tokens" },
    });
    expect(lab.steps.some((s) => s.results?.some((r) => r.tool === "send_mail"))).toBe(false);
  });

  it("shows the timed-out search as a failed result", async () => {
    const lab = await stepThroughRun("search-timeout");
    expect(lab.steps[3].results).toEqual([
      {
        callId: expect.any(String),
        tool: "search_documents",
        ok: false,
        text: "search_documents timed out after 30 s.",
      },
    ]);
  });
});
