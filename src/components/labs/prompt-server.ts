/**
 * The prompt lab (section 10): one recorded chat turn replayed through `#learn/generate/*` and `#learn/cite/*`, the
 * learner's code while a section 10 step is active. Nothing here calls a model: the reply is the recording's,
 * whatever prompt the code builds now.
 */
import type { AnswerResult } from "#learn/generate/answer";

import { answer } from "#learn/generate/answer";
import { buildPrompt, countTokens, DEFAULT_BUDGET, renderSource } from "#learn/generate/prompt";
import { CHAT_REASONING_EFFORT } from "#learn/model/config";
import { recordedReply, recordedTurn, replayModel, type TurnName } from "@/core/generate/recorded";

export interface LabSource {
  /** Its place in retrieval's ranking, from 1. */
  rank: number;
  label: string | null;
  title: string;
  path: string;
  page: number | null;
  /** What the rendered block costs, or would have. */
  tokens: number;
}

export interface PromptInspection {
  name: TurnName;
  recorded: string;
  user: string;
  tenant: string;
  question: string;
  k: number;
  budget: number;
  instructions: string;
  /** The last user turn: the sources and the question. */
  userTurn: string;
  tokens: { instructions: number; sources: number };
  sources: LabSource[];
  skipped: LabSource[];
  /** The recorded reply, as the model wrote it. */
  reply: string;
  verdict:
    | (Pick<AnswerResult, "abstained" | "flagged"> & {
        kept: Array<{ label: string; quote: string; title: string; page: number | null }>;
        dropped: Array<{ marker: string; label: string | null; reason: string }>;
      })
    | null;
  /** An error the code under test threw, and where. */
  error: string | null;
}

export async function inspectTurn(name: TurnName, k: number, budget: number): Promise<PromptInspection> {
  const turn = recordedTurn(name);
  const chunks = turn.chunks.slice(0, k);
  const base = {
    name,
    recorded: turn.recorded,
    user: turn.user,
    tenant: turn.tenant,
    question: turn.question,
    k,
    budget,
    reply: recordedReply(name),
  };
  let prompt;
  try {
    prompt = buildPrompt({ question: turn.question, chunks, budget: { ...DEFAULT_BUDGET, sources: budget } });
  } catch (error) {
    return {
      ...base,
      instructions: "",
      userTurn: "",
      tokens: { instructions: 0, sources: 0 },
      sources: [],
      skipped: [],
      verdict: null,
      error: `buildPrompt: ${(error as Error).message}`,
    };
  }
  const rankOf = new Map(chunks.map((chunk, i) => [chunk.id, i + 1]));
  const skipped = new Set(prompt.omitted);
  const cost = (label: string, i: number) => {
    try {
      return countTokens(renderSource(label, chunks[i]));
    } catch {
      return 0;
    }
  };

  let verdict: PromptInspection["verdict"] = null;
  let error: string | null = null;
  try {
    for await (const event of answer({
      question: turn.question,
      retrieval: { query: turn.question, rewritten: turn.rewritten, chunks, auditId: "lab" },
      model: replayModel(name).model,
      reasoningEffort: CHAT_REASONING_EFFORT,
      budget: { ...DEFAULT_BUDGET, sources: budget },
    })) {
      if (event.type !== "done") continue;
      const { report, abstained, flagged } = event.result;
      verdict = {
        abstained,
        flagged,
        kept: report.citations.map((c) => ({ label: c.label, quote: c.quote, title: c.title, page: c.page })),
        dropped: report.dropped.map((d) => ({ marker: d.marker, label: d.label, reason: d.reason })),
      };
    }
  } catch (caught) {
    error = `answer: ${(caught as Error).message}`;
  }

  return {
    ...base,
    instructions: prompt.instructions,
    userTurn: prompt.messages.at(-1)?.content ?? "",
    tokens: { instructions: prompt.tokens.instructions, sources: prompt.tokens.sources },
    sources: prompt.sources.map((source) => {
      const rank = rankOf.get(source.chunkId) ?? 0;
      return {
        rank,
        label: source.label,
        title: source.title,
        path: source.path,
        page: source.pageStart,
        tokens: cost(source.label, rank - 1),
      };
    }),
    skipped: chunks.flatMap((chunk, i) =>
      skipped.has(chunk.id)
        ? [
            {
              rank: i + 1,
              label: null,
              title: chunk.title,
              path: chunk.path,
              page: chunk.pageStart,
              // Counted with the label it would have taken: the next one after the sources ranked above it.
              tokens: cost(`S${prompt.sources.filter((s) => (rankOf.get(s.chunkId) ?? 0) < i + 1).length + 1}`, i),
            },
          ]
        : [],
    ),
    verdict,
    error,
  };
}
