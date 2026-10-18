import type { ChatModel, FinishReason, ReasoningEffort, TextMessage, Usage } from "#learn/model/types";
import type { Retrieval } from "#learn/retrieve/types";

import { validateCitations, type CitableSource, type CitationReport } from "#learn/cite/citations";
import {
  ABSTAIN_TEXT,
  buildPrompt,
  DEFAULT_BUDGET,
  normalizeAbstention,
  type PromptBudget,
} from "#learn/generate/prompt";

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

const EMPTY_REPORT: CitationReport = { citations: [], dropped: [], flagged: false };

/**
 * Answers one question from a retrieval: sources first, then the streamed text, then the validated result. With
 * nothing retrieved it abstains without calling the model.
 */
export async function* answer(input: AnswerInput): AsyncGenerator<AnswerEvent> {
  const prompt = buildPrompt({
    question: input.question,
    chunks: input.retrieval.chunks,
    history: input.history,
    budget: input.budget ?? DEFAULT_BUDGET,
  });
  yield { type: "sources", sources: prompt.sources };

  if (prompt.sources.length === 0) {
    yield { type: "text-delta", delta: ABSTAIN_TEXT };
    yield {
      type: "done",
      result: {
        text: ABSTAIN_TEXT,
        report: EMPTY_REPORT,
        abstained: true,
        flagged: false,
        finishReason: "abstained",
        usage: null,
      },
    };
    return;
  }

  let text = "";
  let finishReason: FinishReason = "other";
  let usage: Usage | null = null;
  for await (const event of input.model.stream({
    instructions: prompt.instructions,
    messages: prompt.messages,
    reasoningEffort: input.reasoningEffort,
    maxOutputTokens: input.maxOutputTokens,
    abortSignal: input.abortSignal,
  })) {
    if (event.type === "text-delta") {
      text += event.delta;
      yield event;
    } else if (event.type === "finish") {
      finishReason = event.finishReason;
      usage = event.usage;
    }
  }

  // Only the sentence on its own: anything after it is an answer, checked like one.
  const abstained = normalizeAbstention(text) === normalizeAbstention(ABSTAIN_TEXT);
  const report = abstained
    ? { ...validateCitations(text, prompt.sources), flagged: false }
    : validateCitations(text, prompt.sources);
  yield {
    type: "done",
    result: { text, report, abstained, flagged: !abstained && report.flagged, finishReason, usage },
  };
}
