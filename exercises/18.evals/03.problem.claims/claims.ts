// 👨‍💼 One verdict per answer says "unfaithful" and stops. Kestrel wants to know which part of an answer the
//    sources don't back: the wrong sum, the date nobody wrote, the claim that cites a source saying something else.
//    So an answer is split into claims and each one is checked. The eval dashboard and `pnpm eval:judge` run this
//    file over the 20 hand-labelled answers.
//
// 🦉 Already written in this file: the schemas, both sets of instructions, `citedLabels` and `decomposeClaims`
//    (one model call that splits an answer into claims, keeping only labels the answer really cited). You write
//    `checkMessage`, `checkClaims` and `scoreClaims`.

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

/** The claims, numbered, each followed by the labels of the sources it may be checked against. */
export function checkMessage(claims: Claim[], sources: CitableSource[]): string {
  // 🐨 One line per claim, numbered from 1: `1. <claim> (sources: S2)`. A claim that cited sources lists its own
  //    labels; one that cited none lists every source's label, in order (`S1, S2, ..., S8`).
  // 🐨 The message is the sources, then the claims: `<sources>`, the sources rendered as the answer's prompt
  //    rendered them, `</sources>`, a blank line, `<claims>`, the lines, `</claims>`, each on its own line.
  //
  // 💰 `renderSource` from `#learn/generate/prompt` renders one source block; add the import. A `CitableSource`
  //    becomes what it wants with `renderSource(s.label, { ...s, id: s.chunkId, section: null, score: 0 })`. Join
  //    the blocks with a blank line.
  //
  // 🦉 Why a claim sees only what it cited. The answer said where each fact came from. "The limit is £180
  //    [[S1: ...]]" claims S1 says so, and S1 does. Checking against what was cited tests the answer's own story,
  //    and the evidence names a source a person can open. An uncited claim has no story, so every source is fair.
  //
  // 🚨 The tests check the numbering, a claim's own labels, every label for an uncited claim, and the sources.
  throw new Error(`checkMessage(${claims.length} claims, ${sources.length} sources) isn't written yet`);
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
  // 🐨 No claims (an abstention, a greeting): no call. Return no checks and `usage: null`.
  // 🐨 Otherwise make one `model.object` call for all the claims: `CHECK_INSTRUCTIONS`, one user message with your
  //    `checkMessage`, the schema name `claim_checks`, the effort you were given, and `ClaimChecksSchema`.
  // 🐨 Then give back every claim, in its own order, with its verdict and evidence from the check whose `claim`
  //    number is its own (counting from 1), and `uncited` when it cited no source.
  // 🐨 The classic mistake: matching checks to claims by their place in the reply. The model may answer out of
  //    order or skip one. Match by number; a claim it skipped is `not_found`, with no evidence.
  //
  // 💰 A `Map` keyed by the claim number finds each claim's check in one lookup.
  //
  // 🦉 Why one call. Grace's answer has four claims; the whole set has 48. Her check call sent 4,042 tokens, nearly
  //    all of it the eight sources. A call per claim would send them four times over. One call with numbered
  //    claims checks them all against one reading, and the recordings hold one check call per answer.
  // 🦉 Why a skipped claim isn't supported. Silence from the checker is no evidence. Counted as supported, a
  //    checker that answered for only the easy claims would make every answer look faithful.
  //
  // 🚨 The tests check one call, matching by number, a skipped claim, no call for no claims, and Grace's four.
  throw new Error(
    `checkClaims(${typeof model}, ${input.claims.length} claims, ${input.sources.length} sources, ${reasoningEffort}) isn't written yet`,
  );
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
  // 🐨 Count the claims, each verdict, and the uncited ones. Faithfulness is supported over all claims; an answer
  //    with no claims scores 1.
  // 🐨 The classic mistake: counting only the contradicted as failures. A claim the sources don't back
  //    (`not_found`) is a claim the answer made up, and it costs as much.
  //
  // 🦉 Why 1 for no claims. Heron's recorded abstention, "I couldn't find an answer to that in the documents you
  //    can access", says nothing about the world, so it says nothing false. A score of 0 would punish the
  //    assistant for abstaining when it should, which is exactly what section 10 taught it to do.
  //
  // 🚨 The tests check the counts, 3 of 4 as 0.75, `not_found` counted against, and 1 for no claims.
  throw new Error(`scoreClaims(${checked.length} checked claims) isn't written yet`);
}
