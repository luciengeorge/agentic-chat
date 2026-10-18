// 👨‍💼 When the sources don't answer, Kestrel's assistant must say so in one fixed sentence and stop. A guess about
//    Project Heron, said with confidence to an intern, is worse than no answer.
//
// 🦉 New in this file: nothing but the types. `buildPrompt` (step 1 and `prompt.ts`), `validateCitations` (step 4
//    writes it; the reference runs for now) and `normalizeAbstention` are ready to call.

import type { CitableSource, CitationReport } from "#learn/cite/citations";
import type { PromptBudget } from "#learn/generate/prompt";
import type { ChatModel, FinishReason, ReasoningEffort, TextMessage, Usage } from "#learn/model/types";
import type { Retrieval } from "#learn/retrieve/types";

export type AnswerEvent =
  | { type: "sources"; sources: CitableSource[] }
  | { type: "text-delta"; delta: string }
  | { type: "done"; result: AnswerResult };

export interface AnswerResult {
  text: string;
  report: CitationReport;
  /** The sources didn't answer, so the assistant said so. */
  abstained: boolean;
  /** A citation was dropped, or a non-abstaining answer cited nothing. */
  flagged: boolean;
  finishReason: FinishReason | "abstained";
  usage: Usage | null;
}

export interface AnswerInput {
  question: string;
  history?: TextMessage[];
  retrieval: Retrieval;
  model: ChatModel;
  reasoningEffort: ReasoningEffort;
  budget?: PromptBudget;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

/**
 * Answers one question from a retrieval: sources first, then the streamed text, then the validated result. With
 * nothing retrieved it abstains without calling the model.
 */
export async function* answer(input: AnswerInput): AsyncGenerator<AnswerEvent> {
  // 🐨 Build the prompt from the question, the retrieved chunks and the history, with the input's budget or the
  //    default. Yield the sources it kept, first, so the browser can show them before any text.
  // 🐨 If no source went in, don't call the model: yield the abstain sentence as one text delta, then `done` with
  //    that text, an empty report (no citations, nothing dropped, not flagged), abstained, not flagged, finish
  //    reason "abstained" and no usage. Then return.
  // 🐨 Otherwise stream the model with the prompt's instructions and messages and the input's reasoning effort,
  //    output cap and abort signal. Pass each text delta on as you get it, and keep the text; keep the finish
  //    event's reason and usage.
  // 🐨 At the end decide two things. It abstained only if the whole text, normalised, is the abstain sentence,
  //    normalised: not if it merely contains it. Validate the citations either way, but an abstention is never
  //    flagged; an answer is flagged when the report is. Yield `done`.
  //
  // 💰 Add `import { validateCitations } from "#learn/cite/citations"` and `import { ABSTAIN_TEXT, buildPrompt,
  //    DEFAULT_BUDGET, normalizeAbstention } from "#learn/generate/prompt"`. `for await (const event of
  //    input.model.stream({...}))` reads the model; its events are `text-delta` and `finish`. `yield event` passes
  //    one on.
  //
  // 🦉 Why no model call on nothing. With no sources the only honest reply is the abstention, and a model asked
  //    anyway will answer from what it learned in training: the plausible guess this whole section exists to stop.
  //    It's also free, and it says nothing about why: "you can't see that" would tell Leo the memo exists.
  // 🦉 Why the whole text. The rule asks for exactly the sentence. A reply that says it and then "but Heron is a
  //    payments acquisition..." has answered, from somewhere, so it must be checked like an answer, and with no
  //    citations it's flagged. `includes` would let that through as an abstention, unflagged.
  // 🦉 Why normalise. Models write ’ for ' and add or drop the full stop; `normalizeAbstention` lower-cases,
  //    straightens the apostrophe and trims closing punctuation, so those still count.
  // 🦉 Why stream as you go. The browser shows each delta the moment it's yielded. Collect the text and yield it
  //    at the end, and Leo stares at nothing for the seconds the model takes, then gets it all at once.
  //
  // 🚨 The tests check sources first, an empty retrieval abstaining with no request sent, deltas passed on as they
  //    come with the effort and cap sent, the abstention rules, and the recorded Heron and Brightwell replies.
  throw new Error(`answer(${JSON.stringify(input.question)}) isn't written yet`);
}
