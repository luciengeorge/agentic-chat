import { generateText, type LanguageModel, Output } from "ai";
import { z } from "zod";

import type { Embedder } from "#learn/embed/embed";
import type { ReasoningEffort } from "#learn/query/rewrite";

/**
 * HyDE (hypothetical document embeddings): a question and the passage that answers it are worded differently ("how
 * much can I spend on a hotel?" against "Hotel accommodation is reimbursed up to £200 per night"), so their vectors
 * sit apart. A model writes a passage that *would* answer the question, in a document's words, and search runs on
 * that passage's embedding instead. Its facts may be wrong: only its wording and topic matter, and it's never shown.
 */
export type HypotheticalWriter = (question: string) => Promise<string>;

/** Longer passages cost more to embed and drift from the question. */
export const MAX_PASSAGE_CHARS = 2000;

/** What the model must return: one passage. */
export const PassageSchema = z.object({
  passage: z.string().describe("A passage from an internal document that would answer the question"),
});

/** HyDE's instructions to the model. */
export const HYDE_INSTRUCTIONS = `You help search a company's internal documents: policies, reports, contracts, runbooks.
Write the passage, 50 to 120 words, that a document answering the question would contain, in that document's words.
If you don't know the facts, write plausible ones: the passage is only used to search, never shown.
Keep any identifier in the question (a contract number like KPC-2026-0142, an error code like KP-4031, a SKU) exactly as written.`;

/** The model writes the passage as structured output, at an explicit reasoning effort. */
export function modelHypothesis(model: LanguageModel, reasoning: ReasoningEffort): HypotheticalWriter {
  return async (question) => {
    const { output } = await generateText({
      model,
      system: HYDE_INSTRUCTIONS,
      prompt: question,
      output: Output.object({ schema: PassageSchema, name: "hypothetical_passage" }),
      reasoning,
    });
    const passage = output.passage.trim().slice(0, MAX_PASSAGE_CHARS);
    if (passage === "") throw new Error("the model wrote an empty passage");
    return passage;
  };
}

/** The passage and its embedding: `retrieve` searches it as one more vector list, beside the question's. */
export async function hydeEmbedding(
  question: string,
  deps: { writer: HypotheticalWriter; embedder: Embedder },
): Promise<{ passage: string; embedding: number[] }> {
  const passage = await deps.writer(question);
  const [embedding] = await deps.embedder.embed([passage]);
  return { passage, embedding };
}
