/**
 * The eval dashboard (section 18's lab): the parts of `evalDashboard` (`src/core/eval/dashboard.ts`), each run on
 * its own so an unfinished step shows its error in its own panel, plus every golden-set report scored again by
 * `#learn/eval/metrics`. All of it goes through `#learn/eval/*`, so it's the learner's code while a section 18 step
 * is active. Nothing calls a model or the database: the reports are on disk and the judge, the claim checker and
 * the agent tasks replay their recordings.
 */
import type { TaskSummary } from "#learn/eval/agent-tasks";
import type { FaithfulnessResult, FaithfulnessSummary } from "#learn/eval/faithfulness";

import { runAgentTasks } from "#learn/eval/agent-tasks";
import { describeKappa } from "#learn/eval/kappa";
import * as metrics from "#learn/eval/metrics";
import { type GoldenRun, readGoldenRuns, replayFaithfulness } from "@/core/eval/dashboard";
import { readGoldenReport } from "@/core/eval/golden-report";

/** A panel's data, or the error that stopped it (a step's "isn't written yet"). */
export type Part<T> = { ok: true; value: T } | { ok: false; error: string };

export async function part<T>(fn: () => T | Promise<T>): Promise<Part<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface Rescored {
  recallAt10: number;
  mrr: number;
  ndcgAt10: number;
  /** Questions whose scores differ from what the run recorded. */
  differ: string[];
}

export interface GoldenRow extends GoldenRun {
  /** The run's rankings scored again by `#learn/eval/metrics`. */
  rescored: Part<Rescored>;
}

type Metrics = Partial<typeof metrics>;

/** Scores a report's rankings again with whatever `#learn/eval/metrics` holds now. */
export function rescore(file: string, m: Metrics = metrics): Rescored {
  const { judge, recallAtK, reciprocalRank, ndcgAtK, mean } = m;
  if (!judge) throw new Error("`judge` isn't in metrics.ts yet (step 18.1)");
  if (!recallAtK || !reciprocalRank || !ndcgAtK || !mean) {
    throw new Error("the ranking metrics aren't in metrics.ts yet (step 18.2)");
  }
  const answered = readGoldenReport(file).questions.filter((q) => q.labels.length > 0);
  const scored = answered.map((q) => {
    const judged = judge(q.ranked, q.labels);
    return {
      id: q.id,
      recorded: q.scores,
      recallAt10: recallAtK(judged, q.labels.length, 10),
      reciprocalRank: reciprocalRank(judged),
      ndcgAt10: ndcgAtK(judged, q.labels.length, 10),
    };
  });
  const near = (a: number, b: number | undefined) => b !== undefined && Math.abs(a - b) < 1e-9;
  return {
    recallAt10: mean(scored.map((s) => s.recallAt10)),
    mrr: mean(scored.map((s) => s.reciprocalRank)),
    ndcgAt10: mean(scored.map((s) => s.ndcgAt10)),
    differ: scored
      .filter(
        (s) =>
          !near(s.recallAt10, s.recorded?.recallAt10) ||
          !near(s.reciprocalRank, s.recorded?.reciprocalRank) ||
          !near(s.ndcgAt10, s.recorded?.ndcgAt10),
      )
      .map((s) => s.id),
  };
}

export interface Agreement {
  counts: { faithful: { faithful: number; unfaithful: number }; unfaithful: { faithful: number; unfaithful: number } };
  observed: number;
  chance: number;
  kappa: number;
  words: string;
  disagreements: string[];
}

export interface FaithfulnessView {
  items: Array<Pick<FaithfulnessResult, "id" | "label" | "judge" | "claimsVerdict" | "score">>;
  judge: Agreement;
  claims: Agreement;
  claimsPerAnswer: number;
  meanFaithfulness: FaithfulnessSummary["meanFaithfulness"];
}

function agreement(c: FaithfulnessSummary["judge"]): Agreement {
  return {
    counts: c.confusion.counts,
    observed: c.observed,
    chance: c.chance,
    kappa: c.kappa,
    words: describeKappa(c.kappa),
    disagreements: c.disagreements,
  };
}

export interface EvalsLab {
  golden: GoldenRow[];
  faithfulness: Part<FaithfulnessView | null>;
  agentTasks: Part<TaskSummary>;
}

export async function evalsLab(): Promise<EvalsLab> {
  const golden = await Promise.all(
    readGoldenRuns().map(async (run) => ({ ...run, rescored: await part(() => rescore(run.file)) })),
  );
  const faithfulness = await part(async () => {
    const replayed = await replayFaithfulness();
    if (!replayed) return null;
    const { results, summary } = replayed;
    return {
      items: results.map(({ id, label, judge, claimsVerdict, score }) => ({ id, label, judge, claimsVerdict, score })),
      judge: agreement(summary.judge),
      claims: agreement(summary.claims),
      claimsPerAnswer: summary.claimsPerAnswer,
      meanFaithfulness: summary.meanFaithfulness,
    };
  });
  return { golden, faithfulness, agentTasks: await part(() => runAgentTasks()) };
}
