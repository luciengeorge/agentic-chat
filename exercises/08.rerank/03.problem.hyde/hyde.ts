// 👨‍💼 A question and the passage that answers it are worded differently. "What did the Ombudsman decide on
//    CMP-2026-01171?" is a question; the filing says "the Financial Ombudsman Service upheld complaint
//    CMP-2026-01171". HyDE asks the model to write an answer first, facts and all, and searches with that.

import { type LanguageModel } from "ai";
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
    // 🐨 Ask the model for a passage as structured output: `HYDE_INSTRUCTIONS` as the system prompt, the question
    //    as the prompt, `PassageSchema` named "hypothetical_passage", and the reasoning effort.
    // 🐨 Trim the passage and cut it at MAX_PASSAGE_CHARS. If nothing's left, throw.
    //
    // 💰 Add `generateText` and `Output` to the import from "ai". `const { output } = await generateText({ model,
    //    system, prompt, output: Output.object({ schema, name }), reasoning })`; `output.passage` is the string.
    //
    // 🦉 Why a made-up answer can help. An embedding puts text with the same meaning and the same kind of wording
    //    close together. A question and its answer have the same topic but different wording, so they sit
    //    further apart than two answers do. The model's passage is answer-shaped: it reads like the document,
    //    so it lands nearer the documents that answer. Its facts may be wrong, and that's fine: it's only used
    //    to search, never shown, and the identifier in the question is kept exactly as written.
    // 🦉 Why a cap and a refusal. A long passage drifts from the question and costs more to embed. An empty
    //    one would search for nothing and look like a result.
    //
    // 📜 https://arxiv.org/abs/2212.10496 (Gao et al., "Precise Zero-Shot Dense Retrieval without Relevance
    //    Labels", the HyDE paper)
    //
    // 🚨 The tests check the request (instructions, question, "hypothetical_passage", the effort), the trim and
    //    the cap, and that an empty passage or a reply that doesn't fit throws.
    throw new Error(
      `modelHypothesis(${typeof model}, ${reasoning})(${JSON.stringify(question)}) isn't written yet (${typeof PassageSchema}, ${HYDE_INSTRUCTIONS.length} characters of instructions)`,
    );
  };
}

/** The passage and its embedding: `retrieve` searches it as one more vector list, beside the question's. */
export async function hydeEmbedding(
  question: string,
  deps: { writer: HypotheticalWriter; embedder: Embedder },
): Promise<{ passage: string; embedding: number[] }> {
  // 🐨 Have the writer write a passage for the question, embed the passage, and return both.
  //
  // 💰 `deps.embedder.embed([text])` returns one vector per text.
  //
  // 🦉 Embed the passage, and only the passage. The classic slip is to embed the question (then HyDE does
  //    nothing) or the question and the passage joined (then the vector sits between the two, and you've paid
  //    for a model call to move it halfway).
  // 🦉 Why it doesn't win here. On Sofia's question the passage is nearer both answers than the question is.
  //    But this corpus has a 3,000-page filing whose complaints register reads just like an Ombudsman decision,
  //    so the passage's 40 nearest chunks are all filing pages. Retrieval adds them as one more list, every
  //    filing page gains a share in the fusion, and the Compliance Monitoring Report's page 3 slides from #27
  //    to #33: past the 30 the reranker reads. That's the eval's one HyDE miss (recall 0.988 against 1.000).
  //
  // 🚨 The tests check that the passage is embedded, not the question, and reproduce the numbers above from the
  //    recorded vectors and lists.
  throw new Error(
    `hydeEmbedding(${JSON.stringify(question)}, ${typeof deps.writer}, ${deps.embedder.version}) isn't written yet`,
  );
}
