import { describe, expect, it } from "vitest";

import { summarize, type ScoredQuestion } from "./summary";

const q = (over: Partial<ScoredQuestion> & Pick<ScoredQuestion, "id">): ScoredQuestion => ({
  expect: "answer",
  traps: [],
  scores: { recallAt10: 1, reciprocalRank: 1, ndcgAt10: 1 },
  leaks: [],
  crossTenant: [],
  answer: null,
  error: null,
  ...over,
});

describe("summarize", () => {
  it("averages the answer cases overall and per trap, and passes the bar", () => {
    const summary = summarize([
      q({ id: "a", traps: ["lexical"] }),
      q({ id: "b", traps: ["lexical", "tables"], scores: { recallAt10: 0.5, reciprocalRank: 0.5, ndcgAt10: 0.5 } }),
      q({ id: "c", expect: "abstain", scores: null }),
    ]);
    expect(summary.scores).toEqual({ questions: 2, recallAt10: 0.75, mrr: 0.75, ndcgAt10: 0.75, passed: false });
    expect(summary.byTrap.lexical.recallAt10).toBe(0.75);
    expect(summary.byTrap.tables).toEqual({ questions: 1, recallAt10: 0.5, mrr: 0.5, ndcgAt10: 0.5 });
    expect(summary.gates.passed).toBe(true);
    expect(summary.answers).toBeNull();
  });

  it("fails the gates on a leak, another tenant, a missed abstention or an error", () => {
    const summary = summarize([
      q({ id: "leak", leaks: ["retrieved /Exec/memo.pdf"] }),
      q({ id: "tenant", crossTenant: ["/Policies/x.pdf"] }),
      q({ id: "talked", expect: "abstain", scores: null, answer: { passed: false, reasons: ["answered"] } }),
      q({ id: "broke", error: "429" }),
      q({ id: "ok", answer: { passed: true, reasons: [] } }),
      q({ id: "uncited", answer: { passed: false, reasons: ["cited nothing"] } }),
    ]);
    expect(summary.gates).toEqual({
      leaks: ["leak"],
      crossTenant: ["tenant"],
      abstentionsMissed: ["talked"],
      errors: ["broke"],
      passed: false,
    });
    expect(summary.answers).toEqual({ passed: 1, total: 2, failed: ["uncited"] });
  });
});
