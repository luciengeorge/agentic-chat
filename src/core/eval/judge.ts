/**
 * An LLM judge for faithfulness, and how to tell whether to trust it.
 *
 * Faithful means every claim in the answer is backed by the sources the assistant was given. It isn't the same as
 * right (a source can be wrong) or complete (an answer can skip half the question and still be faithful). A judge
 * is another model call that reads the sources and the answer and says "faithful" or "unfaithful".
 *
 * A judge is a measuring instrument, so it needs calibrating like one: a person labels a small set by hand, the
 * judge labels the same set, and Cohen's kappa (`#learn/eval/kappa`) says how far beyond luck they agree. Only once
 * that's high enough is the judge allowed to grade answers nobody labelled.
 */
import { z } from "zod";

import type { CitableSource } from "#learn/cite/citations";
import type { ReasoningEffort, StructuredModel, Usage } from "#learn/model/types";

import { chanceAgreement, cohensKappa, confusionMatrix, type Confusion, observedAgreement } from "#learn/eval/kappa";
import { renderSource } from "#learn/generate/prompt";

export type Faithfulness = "faithful" | "unfaithful";

export const FAITHFULNESS: readonly Faithfulness[] = ["faithful", "unfaithful"];

export interface JudgeInput {
  question: string;
  answer: string;
  /** The sources the assistant saw, labelled as its prompt labelled them. */
  sources: CitableSource[];
}

export const JudgeVerdictSchema = z.object({
  /** Written first, so the verdict comes after the reasoning, not before it. */
  reason: z.string().describe("One or two sentences: the claim that decided it, and what the sources say about it."),
  verdict: z.enum(["faithful", "unfaithful"]),
});

export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export const JUDGE_INSTRUCTIONS = `You check whether an assistant's answer is faithful to the sources it was given.

Faithful means every factual claim in the answer is stated in, or follows directly from, the sources. Judge only that:
- An answer that leaves part of the question unanswered can still be faithful.
- "I couldn't find an answer" is faithful when the sources really don't answer.
- A number, date, name or condition that differs from the sources makes the answer unfaithful.
- So does a claim the sources don't make, even a plausible one.
- When sources disagree (an old and a new version), presenting the old value as the current one is unfaithful.
- Citation markers like [[S1: "..."]] are not claims. Ignore them, and don't trust them: check the claim itself.

Reply with a short reason, then the verdict.`;

/** The sources in the same `<source>` blocks the answer's own prompt used. */
export function renderSources(sources: CitableSource[]): string {
  return sources.map((s) => renderSource(s.label, { ...s, id: s.chunkId, section: null, score: 0 })).join("\n\n");
}

export function judgeMessage(input: JudgeInput): string {
  return `<sources>\n${renderSources(input.sources)}\n</sources>\n\n<question>\n${input.question}\n</question>\n\n<answer>\n${input.answer}\n</answer>`;
}

/** One judge call: the model reads the sources, the question and the answer, and gives a verdict with its reason. */
export async function judgeFaithfulness(
  model: StructuredModel,
  input: JudgeInput,
  reasoningEffort: ReasoningEffort,
): Promise<JudgeVerdict & { usage: Usage }> {
  const { object, usage } = await model.object(
    {
      instructions: JUDGE_INSTRUCTIONS,
      messages: [{ role: "user", content: judgeMessage(input) }],
      name: "faithfulness_verdict",
      reasoningEffort,
    },
    JudgeVerdictSchema,
  );
  return { ...object, usage };
}

export interface Calibration {
  /** Rows are the hand labels, columns the judge's verdicts. */
  confusion: Confusion<Faithfulness>;
  observed: number;
  chance: number;
  kappa: number;
  /** The items where the judge and the hand label differ. */
  disagreements: string[];
}

/** Compares a judge's verdicts with the hand labels, item by item. */
export function calibrate(
  items: ReadonlyArray<{ id: string; label: Faithfulness; verdict: Faithfulness }>,
): Calibration {
  const confusion = confusionMatrix(
    items.map((i) => i.label),
    items.map((i) => i.verdict),
    FAITHFULNESS,
  );
  return {
    confusion,
    observed: observedAgreement(confusion),
    chance: chanceAgreement(confusion),
    kappa: cohensKappa(confusion),
    disagreements: items.filter((i) => i.label !== i.verdict).map((i) => i.id),
  };
}
