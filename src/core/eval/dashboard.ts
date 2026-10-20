/**
 * Everything the eval dashboard (the section 18 lab) shows, from files already on disk: the golden-set reports
 * `pnpm eval` wrote, the judge and claim calls replayed against the hand labels, and the agent tasks replayed on
 * their recorded runs. Nothing here calls a model or the database.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runAgentTasks, type TaskSummary } from "#learn/eval/agent-tasks";
import {
  type FaithfulnessResult,
  type FaithfulnessSummary,
  judgeItem,
  summarizeFaithfulness,
} from "#learn/eval/faithfulness";
import { CHAT_REASONING_EFFORT } from "#learn/model/config";

import { loadJudgeSet } from "./judge-set";
import { evalRecording, replayEvalModel } from "./recorded";

export const GOLDEN_REPORTS = join(import.meta.dirname, "../../../fixtures/golden/reports");

/** One `pnpm eval` run, as its JSON report summarised it. */
export interface GoldenRun {
  file: string;
  date: string;
  /** `full`, `retrieval-only`, and the options (`-hyde`, `-route5`). */
  mode: string;
  questions: number;
  recallAt10: number;
  mrr: number;
  ndcgAt10: number;
  gatesPassed: boolean;
  scoresPassed: boolean;
  /** Answer cases that cited a labelled document; null for a retrieval-only run. */
  answers: { passed: number; total: number } | null;
  costUsd: number;
}

interface ReportJson {
  run: { date: string; mode: string; costUsd: { total: number } };
  summary: {
    questions: number;
    gates: { passed: boolean };
    scores: { recallAt10: number; mrr: number; ndcgAt10: number; passed: boolean };
    answers: { passed: number; total: number } | null;
  };
}

/** Every golden-set report in `dir`, oldest first. */
export function readGoldenRuns(dir: string = GOLDEN_REPORTS): GoldenRun[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const { run, summary } = JSON.parse(readFileSync(join(dir, file), "utf8")) as ReportJson;
      return {
        file,
        date: run.date,
        mode: run.mode,
        questions: summary.questions,
        recallAt10: summary.scores.recallAt10,
        mrr: summary.scores.mrr,
        ndcgAt10: summary.scores.ndcgAt10,
        gatesPassed: summary.gates.passed,
        scoresPassed: summary.scores.passed,
        answers: summary.answers && { passed: summary.answers.passed, total: summary.answers.total },
        costUsd: run.costUsd.total,
      };
    });
}

/** The judge and the claim checker over the hand-labelled set, replayed from their recordings. Null when the
 * recordings aren't there. */
export async function replayFaithfulness(): Promise<{
  results: FaithfulnessResult[];
  summary: FaithfulnessSummary;
} | null> {
  if (!evalRecording("judge") || !evalRecording("claims")) return null;
  const results: FaithfulnessResult[] = [];
  for (const item of loadJudgeSet()) {
    results.push(await judgeItem(item, { modelFor: replayEvalModel, reasoningEffort: CHAT_REASONING_EFFORT }));
  }
  return { results, summary: summarizeFaithfulness(results) };
}

export interface EvalDashboard {
  golden: GoldenRun[];
  faithfulness: Awaited<ReturnType<typeof replayFaithfulness>>;
  agentTasks: TaskSummary;
}

export async function evalDashboard(): Promise<EvalDashboard> {
  return {
    golden: readGoldenRuns(),
    faithfulness: await replayFaithfulness(),
    agentTasks: await runAgentTasks(),
  };
}
