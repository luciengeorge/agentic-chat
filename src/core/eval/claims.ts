/**
 * Claim decomposition: faithfulness measured claim by claim instead of one verdict for the whole answer.
 *
 * 1. `decomposeClaims` asks a model to split the answer into atomic claims: each one a single fact that is true or
 *    false on its own ("v2 sets the London limit at £200 a night"), with the source labels the answer cited for it.
 * 2. `checkClaims` asks a model, for each claim, whether its cited sources support it, contradict it, or don't say.
 *    A claim that cites nothing is checked against every source and marked uncited.
 * 3. `scoreClaims` counts: faithfulness is the share of claims supported. One wrong number in five claims scores
 *    0.8, where a single verdict would only say "unfaithful". That's what makes it useful for finding *which* part
 *    of an answer went wrong.
 *
 * The citation validator (`#learn/cite/citations`) only checks that a quote appears in its source. A quote can be
 * real and the claim beside it still wrong ("£1.58 a pack" quoted, "£800 difference" claimed); this catches that.
 */
import { z } from "zod";

import type { ReasoningEffort, StructuredModel, Usage } from "#learn/model/types";

import { type CitableSource, parseCitations } from "#learn/cite/citations";
import { renderSource } from "#learn/generate/prompt";

export interface Claim {
  text: string;
  /** The source labels the answer cited for this claim ("S1"); empty when it cited none. */
  sources: string[];
}

export const ClaimsSchema = z.object({
  claims: z.array(
    z.object({
      text: z.string().describe("One fact, as a full sentence that makes sense on its own, with no citation marker."),
      sources: z.array(z.string()).describe('The labels the answer cited for this fact, like "S1". Empty if none.'),
    }),
  ),
});

export const DECOMPOSE_INSTRUCTIONS = `You split an assistant's answer into atomic claims.

- An atomic claim is one fact that can be true or false on its own. "The limit rose from £180 to £200" is two claims: the old limit and the new one.
- Write each claim as a full sentence that makes sense without the others: replace "it" and "this" with what they mean, using the question for context.
- Keep the answer's own words and numbers. Don't correct, add or drop anything.
- Citations look like [[S1: "a quote"]]. For each claim, list the labels of the citations that back it (usually the ones right after it). Don't copy the markers into the claim.
- Leave out what isn't a claim about the world: greetings, "I couldn't find an answer", "here is a summary".
- An answer with no claims gets an empty list.`;

/** The labels cited anywhere in an answer, in order of first use. */
export function citedLabels(answer: string): string[] {
  return [
    ...new Set(
      parseCitations(answer)
        .map((c) => c.label)
        .filter(Boolean),
    ),
  ];
}

/** Splits an answer into atomic claims, each with the labels it cited. Labels the answer never cited are dropped. */
export async function decomposeClaims(
  model: StructuredModel,
  input: { question: string; answer: string },
  reasoningEffort: ReasoningEffort,
): Promise<{ claims: Claim[]; usage: Usage }> {
  const { object, usage } = await model.object(
    {
      instructions: DECOMPOSE_INSTRUCTIONS,
      messages: [
        {
          role: "user",
          content: `<question>\n${input.question}\n</question>\n\n<answer>\n${input.answer}\n</answer>`,
        },
      ],
      name: "atomic_claims",
      reasoningEffort,
    },
    ClaimsSchema,
  );
  const cited = new Set(citedLabels(input.answer));
  return {
    claims: object.claims.map((c) => ({ text: c.text.trim(), sources: c.sources.filter((s) => cited.has(s)) })),
    usage,
  };
}

export type ClaimVerdict = "supported" | "contradicted" | "not_found";

export const ClaimChecksSchema = z.object({
  checks: z.array(
    z.object({
      claim: z.number().int().describe("The claim's number, from 1."),
      verdict: z.enum(["supported", "contradicted", "not_found"]),
      evidence: z
        .string()
        .nullable()
        .describe("A short span copied from the sources that decides it, or null when they say nothing about it."),
    }),
  ),
});

export const CHECK_INSTRUCTIONS = `You check claims against sources. Each claim comes with the sources it may use.

For each claim, answer:
- "supported" when its sources state it, or it follows directly from them (simple arithmetic counts).
- "contradicted" when its sources say something different (another number, date, name or condition).
- "not_found" when its sources don't say either way.

Check every claim, in order, by its number. Use only the sources given with that claim. Copy a short span as evidence, or null.`;

export interface CheckedClaim extends Claim {
  verdict: ClaimVerdict;
  evidence: string | null;
  /** The claim cited nothing, so it was checked against every source. */
  uncited: boolean;
}

const renderSources = (sources: CitableSource[]) =>
  sources.map((s) => renderSource(s.label, { ...s, id: s.chunkId, section: null, score: 0 })).join("\n\n");

/** The claims, numbered, each followed by the labels of the sources it may be checked against. */
export function checkMessage(claims: Claim[], sources: CitableSource[]): string {
  const all = sources.map((s) => s.label);
  const lines = claims.map(
    (c, i) => `${i + 1}. ${c.text} (sources: ${(c.sources.length ? c.sources : all).join(", ")})`,
  );
  return `<sources>\n${renderSources(sources)}\n</sources>\n\n<claims>\n${lines.join("\n")}\n</claims>`;
}

/**
 * Checks every claim in one call. A claim is checked against the sources it cited, or all of them when it cited
 * none. A claim the model skips counts as not found.
 */
export async function checkClaims(
  model: StructuredModel,
  input: { claims: Claim[]; sources: CitableSource[] },
  reasoningEffort: ReasoningEffort,
): Promise<{ checked: CheckedClaim[]; usage: Usage | null }> {
  if (input.claims.length === 0) return { checked: [], usage: null };
  const { object, usage } = await model.object(
    {
      instructions: CHECK_INSTRUCTIONS,
      messages: [{ role: "user", content: checkMessage(input.claims, input.sources) }],
      name: "claim_checks",
      reasoningEffort,
    },
    ClaimChecksSchema,
  );
  const byNumber = new Map(object.checks.map((c) => [c.claim, c]));
  return {
    checked: input.claims.map((claim, i) => {
      const check = byNumber.get(i + 1);
      return {
        ...claim,
        verdict: check?.verdict ?? "not_found",
        evidence: check?.evidence ?? null,
        uncited: claim.sources.length === 0,
      };
    }),
    usage,
  };
}

export interface ClaimScore {
  claims: number;
  supported: number;
  contradicted: number;
  notFound: number;
  uncited: number;
  /** Supported claims over all claims; 1 for an answer with none (an abstention claims nothing false). */
  faithfulness: number;
}

export function scoreClaims(checked: CheckedClaim[]): ClaimScore {
  const count = (verdict: ClaimVerdict) => checked.filter((c) => c.verdict === verdict).length;
  const supported = count("supported");
  return {
    claims: checked.length,
    supported,
    contradicted: count("contradicted"),
    notFound: count("not_found"),
    uncited: checked.filter((c) => c.uncited).length,
    faithfulness: checked.length === 0 ? 1 : supported / checked.length,
  };
}
