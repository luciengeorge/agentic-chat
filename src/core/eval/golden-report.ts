/**
 * One `pnpm eval` report (`fixtures/golden/reports/*.json`), read back question by question: each question's labels,
 * the top 10 chunks it got with the label each one found then, and the scores the run gave it. Section 18's tests
 * and the eval dashboard score these rankings again with `#learn/eval/metrics`, so a change to the metrics shows
 * against what the run recorded, without running retrieval.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Label, RankedChunk } from "#learn/eval/metrics";

export const GOLDEN_REPORTS = join(import.meta.dirname, "../../../fixtures/golden/reports");

/** The latest retrieval-only run of the golden set: the baseline the steps quote. */
export const BASELINE_REPORT = "2026-10-14-retrieval-only.json";

export interface ReportChunk extends RankedChunk {
  rank: number;
  /** The label this chunk found when the run judged it, or null. */
  label: number | null;
  score: number;
}

export interface ReportQuestion {
  id: string;
  user: string;
  question: string;
  expect: "answer" | "abstain";
  traps: string[];
  labels: Label[];
  /** The top 10, best first; empty for an abstain case. */
  ranked: ReportChunk[];
  /** What the run scored; null for an abstain case. */
  scores: { recallAt10: number; reciprocalRank: number; ndcgAt10: number } | null;
}

export interface GoldenReport {
  file: string;
  mode: string;
  date: string;
  summary: { questions: number; recallAt10: number; mrr: number; ndcgAt10: number };
  questions: ReportQuestion[];
}

/** "3" is page 3, "3-4" pages 3 to 4, null no pages (md and docx). */
export function parsePages(pages: string | null): { pageStart: number | null; pageEnd: number | null } {
  if (pages === null) return { pageStart: null, pageEnd: null };
  const [start, end = start] = pages.split("-").map(Number);
  return { pageStart: start, pageEnd: end };
}

interface ReportJson {
  run: { date: string; mode: string };
  summary: { scores: { questions: number; recallAt10: number; mrr: number; ndcgAt10: number } };
  questions: Array<
    Omit<ReportQuestion, "ranked"> & {
      ranked: Array<{ rank: number; path: string; pages: string | null; label: number | null; score: number }>;
    }
  >;
}

export function readGoldenReport(file: string = BASELINE_REPORT, dir: string = GOLDEN_REPORTS): GoldenReport {
  const json = JSON.parse(readFileSync(join(dir, file), "utf8")) as ReportJson;
  const { questions, recallAt10, mrr, ndcgAt10 } = json.summary.scores;
  return {
    file,
    mode: json.run.mode,
    date: json.run.date,
    summary: { questions, recallAt10, mrr, ndcgAt10 },
    questions: json.questions.map((q) => ({
      id: q.id,
      user: q.user,
      question: q.question,
      expect: q.expect,
      traps: q.traps,
      labels: q.labels,
      ranked: (q.ranked ?? []).map((c) => ({
        rank: c.rank,
        path: c.path,
        ...parsePages(c.pages),
        label: c.label,
        score: c.score,
      })),
      scores: q.scores,
    })),
  };
}
