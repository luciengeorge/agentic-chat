import { generateText, type LanguageModel, Output } from "ai";
import { z } from "zod";

export type ReasoningEffort = NonNullable<Parameters<typeof generateText>[0]["reasoning"]>;

/** Up to this many extra queries per question. Each costs a BM25 query and a vector query. */
export const MAX_REWRITES = 3;

/** Rewrites a question into search queries: other phrasings, expansions, the identifiers it names. */
export type QueryRewriter = (query: string) => Promise<string[]>;

const RewriteSchema = z.object({
  queries: z
    .array(z.string())
    .describe("Search queries for the same need, each different from the question and from each other"),
});

const SYSTEM = `You turn a question to a company's internal search into search queries.
Write up to ${MAX_REWRITES} short queries that would find the passages answering it:
- a rephrasing in the words a policy, report or contract would use;
- the key terms expanded (acronyms spelled out, synonyms);
- any identifier in the question (a contract number like KPC-2026-0142, an error code like KP-4031, a SKU) kept exactly as written.
Don't answer the question. Don't invent identifiers, names or numbers that aren't in it.`;

/** The model writes the rewrites as structured output. The reasoning effort is always explicit: some models
 * default to none. */
export function modelRewriter(model: LanguageModel, reasoning: ReasoningEffort): QueryRewriter {
  return async (query) => {
    const { output } = await generateText({
      model,
      system: SYSTEM,
      prompt: query,
      output: Output.object({ schema: RewriteSchema, name: "search_queries" }),
      reasoning,
    });
    return cleanRewrites(query, output.queries);
  };
}

/** Trimmed, without blanks, repeats or the question itself, at most MAX_REWRITES. */
export function cleanRewrites(query: string, rewrites: string[]): string[] {
  const seen = new Set([query.trim().toLowerCase()]);
  const out: string[] = [];
  for (const rewrite of rewrites) {
    const text = rewrite.trim();
    const key = text.toLowerCase();
    if (text === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length === MAX_REWRITES) break;
  }
  return out;
}

/** No rewriting: retrieval searches the question alone. For tests, and when there's no model key. */
export const noRewriter: QueryRewriter = async () => [];
