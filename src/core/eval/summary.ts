import type { CheckResult, Expectation } from "./checks";

import { mean } from "./metrics";

/** The scores M1 must clear, over the `answer` cases. The gates (no leaks, no other tenant, every abstention) are absolute. */
export const BAR = { recallAt10: 0.85, mrr: 0.6 } as const;

export interface Scores {
  recallAt10: number;
  reciprocalRank: number;
  ndcgAt10: number;
}

export interface ScoredQuestion {
  id: string;
  expect: Expectation;
  traps: string[];
  /** Retrieval scores; null for an abstain case, which has no labels. */
  scores: Scores | null;
  leaks: string[];
  crossTenant: string[];
  /** null in a retrieval-only run. */
  answer: CheckResult | null;
  /** The run failed for this question (a model or network error). */
  error: string | null;
}

export interface Averages {
  questions: number;
  recallAt10: number;
  mrr: number;
  ndcgAt10: number;
}

export interface Summary {
  questions: number;
  gates: {
    leaks: string[];
    crossTenant: string[];
    /** Abstain cases that answered; empty in a retrieval-only run. */
    abstentionsMissed: string[];
    errors: string[];
    passed: boolean;
  };
  scores: Averages & { passed: boolean };
  byTrap: Record<string, Averages>;
  /** Answer cases: how many cited a labelled document and didn't abstain. Null in a retrieval-only run. */
  answers: { passed: number; total: number; failed: string[] } | null;
}

function average(questions: ScoredQuestion[]): Averages {
  const scores = questions.flatMap((q) => (q.scores ? [q.scores] : []));
  return {
    questions: scores.length,
    recallAt10: mean(scores.map((s) => s.recallAt10)),
    mrr: mean(scores.map((s) => s.reciprocalRank)),
    ndcgAt10: mean(scores.map((s) => s.ndcgAt10)),
  };
}

export function summarize(questions: ScoredQuestion[]): Summary {
  const leaks = questions.filter((q) => q.leaks.length > 0).map((q) => q.id);
  const crossTenant = questions.filter((q) => q.crossTenant.length > 0).map((q) => q.id);
  const abstentionsMissed = questions
    .filter((q) => q.expect === "abstain" && q.answer && !q.answer.passed)
    .map((q) => q.id);
  const errors = questions.filter((q) => q.error !== null).map((q) => q.id);

  const answerCases = questions.filter((q) => q.expect === "answer");
  const overall = average(answerCases);
  const byTrap: Record<string, Averages> = {};
  for (const trap of [...new Set(answerCases.flatMap((q) => q.traps))].sort()) {
    byTrap[trap] = average(answerCases.filter((q) => q.traps.includes(trap)));
  }
  const checked = answerCases.filter((q) => q.answer !== null);

  return {
    questions: questions.length,
    gates: {
      leaks,
      crossTenant,
      abstentionsMissed,
      errors,
      passed: leaks.length + crossTenant.length + abstentionsMissed.length + errors.length === 0,
    },
    scores: { ...overall, passed: overall.recallAt10 >= BAR.recallAt10 && overall.mrr >= BAR.mrr },
    byTrap,
    answers:
      checked.length === 0
        ? null
        : {
            passed: checked.filter((q) => q.answer!.passed).length,
            total: checked.length,
            failed: checked.filter((q) => !q.answer!.passed).map((q) => q.id),
          },
  };
}
