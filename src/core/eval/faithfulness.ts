/**
 * Runs the judge and the claim checker over the hand-labelled faithfulness set, and compares both with the hand
 * labels. `pnpm eval:judge` and the eval dashboard call it on recordings; `--record` calls it live.
 */
import type { ReasoningEffort, StructuredModel } from "#learn/model/types";

import { checkClaims, type CheckedClaim, type ClaimScore, decomposeClaims, scoreClaims } from "#learn/eval/claims";
import { calibrate, type Calibration, type Faithfulness, judgeFaithfulness } from "#learn/eval/judge";

import type { JudgeItem } from "./judge-set";

export interface FaithfulnessResult {
  id: string;
  label: Faithfulness;
  judge: { verdict: Faithfulness; reason: string };
  claims: CheckedClaim[];
  score: ClaimScore;
  /** The claims method's verdict: faithful only when every claim is supported. */
  claimsVerdict: Faithfulness;
}

export interface FaithfulnessModels {
  /** The model for one item's judge call, or for its claim calls (decompose, then check). */
  modelFor(kind: "judge" | "claims", itemId: string): StructuredModel;
  /** The judge's and the checker's effort. Decomposing is plain rewriting, so it always runs at low. */
  reasoningEffort: ReasoningEffort;
}

export async function judgeItem(item: JudgeItem, models: FaithfulnessModels): Promise<FaithfulnessResult> {
  const judge = await judgeFaithfulness(models.modelFor("judge", item.id), item, models.reasoningEffort);
  const claimModel = models.modelFor("claims", item.id);
  const { claims } = await decomposeClaims(claimModel, item, "low");
  const { checked } = await checkClaims(claimModel, { claims, sources: item.sources }, models.reasoningEffort);
  const score = scoreClaims(checked);
  return {
    id: item.id,
    label: item.label,
    judge: { verdict: judge.verdict, reason: judge.reason },
    claims: checked,
    score,
    claimsVerdict: score.faithfulness === 1 ? "faithful" : "unfaithful",
  };
}

export interface FaithfulnessSummary {
  items: number;
  /** The judge against the hand labels. */
  judge: Calibration;
  /** The claims method (faithful when every claim is supported) against the hand labels. */
  claims: Calibration;
  /** Over the answers that make at least one claim. */
  claimsPerAnswer: number;
  /** Mean claim faithfulness, split by hand label: a working checker scores the faithful ones near 1. */
  meanFaithfulness: Record<Faithfulness, number>;
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN);

export function summarizeFaithfulness(results: FaithfulnessResult[]): FaithfulnessSummary {
  const answered = results.filter((r) => r.score.claims > 0);
  const byLabel = (label: Faithfulness) =>
    mean(results.filter((r) => r.label === label).map((r) => r.score.faithfulness));
  return {
    items: results.length,
    judge: calibrate(results.map((r) => ({ id: r.id, label: r.label, verdict: r.judge.verdict }))),
    claims: calibrate(results.map((r) => ({ id: r.id, label: r.label, verdict: r.claimsVerdict }))),
    claimsPerAnswer: mean(answered.map((r) => r.score.claims)),
    meanFaithfulness: { faithful: byLabel("faithful"), unfaithful: byLabel("unfaithful") },
  };
}
