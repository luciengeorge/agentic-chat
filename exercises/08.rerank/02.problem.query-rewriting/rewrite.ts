// 👨‍💼 Sam Patel asks "When can't we ship code over Christmas?" The deploy runbook answers him in a table row:
//    "Winter freeze, 18 December 2026 to 4 January 2027". It never says "ship" or "Christmas". BM25 can't find a
//    word that isn't there. The model can: it knows that shipping code over Christmas is a deployment freeze.

import { z } from "zod";

import type { ReasoningEffort, StructuredModel } from "#learn/model/types";

export type { ReasoningEffort };

/** Up to this many extra queries per question. Each costs a BM25 query and a vector query. */
export const MAX_REWRITES = 3;

/** Rewrites a question into search queries: other phrasings, expansions, the identifiers it names. */
export type QueryRewriter = (query: string) => Promise<string[]>;

/** What the model must return: up to three queries. */
export const RewriteSchema = z.object({
  queries: z
    .array(z.string())
    .describe("Search queries for the same need, each different from the question and from each other"),
});

/** The rewriter's instructions. Each rule is there for a reason: see section 08.2. */
export const REWRITE_INSTRUCTIONS = `You turn a question to a company's internal search into search queries.
Write up to ${MAX_REWRITES} short queries that would find the passages answering it:
- a rephrasing in the words a policy, report or contract would use;
- the key terms expanded (acronyms spelled out, synonyms);
- any identifier in the question (a contract number like KPC-2026-0142, an error code like KP-4031, a SKU) kept exactly as written.
Don't answer the question. Don't invent identifiers, names or numbers that aren't in it.`;

/** The model writes the rewrites as structured output (`object`, `#learn/model/types`). The reasoning effort is
 * always explicit: some models default to none. */
export function modelRewriter(model: StructuredModel, reasoning: ReasoningEffort): QueryRewriter {
  return async (query) => {
    // 🐨 Ask `model.object(...)` for the rewrites: the instructions are `REWRITE_INSTRUCTIONS`, the one message is
    //    the user's question, the schema's name is "search_queries", and the effort is `reasoning`. The schema is
    //    `RewriteSchema`.
    // 🐨 Return its queries, cleaned by `cleanRewrites`.
    // 🐨 Let a failure throw. The classic mistake is to catch it and return [], "to be safe": retrieval then
    //    searches less than it says it did, and nobody can tell.
    //
    // 💰 `const { object } = await model.object({ instructions, messages: [{ role: "user", content: query }],
    //    name, reasoningEffort }, RewriteSchema)` (section 01.4's `StructuredModel`). `object.queries` is a
    //    `string[]`.
    //
    // 🦉 Why the rules in REWRITE_INSTRUCTIONS. "A rephrasing in the words a policy would use" is the point: a
    //    document says "deployment freeze" where a person says "ship code over Christmas". "Kept exactly as
    //    written" is there because a model likes to tidy identifiers: KPC-2026-0142 written as "contract 142"
    //    matches nothing in BM25, which is the one search that finds identifiers. "Don't answer" is there because
    //    an answer is HyDE's job (step 3), and a made-up figure in a query is a made-up search term.
    // 🦉 Why structured output. The reply is parsed against the schema, so "here are some queries: 1. ..." can't
    //    reach search as a query.
    //
    // 📜 https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data
    //
    // 🚨 The tests check the request (the instructions, the question as the one user message, "search_queries",
    //    the effort), that the model's queries are cleaned, and that a reply that doesn't fit the schema throws.
    throw new Error(
      `modelRewriter(${typeof model}, ${reasoning})(${JSON.stringify(query)}) isn't written yet (${MAX_REWRITES} at most, ${typeof RewriteSchema})`,
    );
  };
}

/** Trimmed, without blanks, repeats or the question itself, at most MAX_REWRITES. */
export function cleanRewrites(query: string, rewrites: string[]): string[] {
  // 🐨 Walk the rewrites in order. Trim each one. Skip it when it's empty, when it's the question, or when you've
  //    already kept the same query: compare those in lower case, and with the question trimmed too.
  // 🐨 Keep the first spelling of each query, and stop once you've kept MAX_REWRITES.
  //
  // 💰 A `Set` of lower-cased keys, seeded with the question's, answers "seen it?" in one `has`.
  //
  // 🦉 Why drop the question. Retrieval already searches it. A rewrite that repeats it adds its BM25 and vector
  //    lists a second time, and fusion (section 07) adds up every list a chunk is in: the question's own hits
  //    would count double, and the rewrites' new words would count for less.
  // 🦉 Why repeats go. The same reason, between rewrites: two copies of a query are one search counted twice.
  // 🦉 Why a cap. Each query costs a BM25 search and a vector search inside the request, and an embedding before
  //    it. Three rewrites make 8 searches. Count what you keep: three good ones, not three from the top of a list
  //    that held the question.
  // 🦉 Why lower case only for comparing. "KPC-2026-0142" has to reach BM25 as the model wrote it.
  //
  // 🚨 The tests check trimming and blanks, that the question goes whatever its case or spacing, that a repeat
  //    keeps its first spelling, and that the cap counts what's kept.
  throw new Error(`cleanRewrites(${JSON.stringify(query)}, ${rewrites.length} rewrites) isn't written yet`);
}

/** No rewriting: retrieval searches the question alone. For tests, and when there's no model key. */
export const noRewriter: QueryRewriter = async () => [];
