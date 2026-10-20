// 👨‍💼 A chat turn's model calls are made in four places (the rewriter, the embedder, the reranker, the answer),
//    and none of them knows which request it's working for. This file keeps one ledger per request that every
//    call inside it is charged to, so the turn's span and the cost metric can say what the turn cost.
//
// 🦉 Already written in this file: `RequestCost`, the `AsyncLocalStorage` that holds the ledgers, and
//    `currentRequestCost`. You write `withRequestCost` and `chargeRequest`.

/**
 * What one request spent, call by call. `withRequestCost` opens a ledger for a request (a chat turn, an agent step),
 * and every model call made inside it, however deep, is charged to it with `chargeRequest`: the AI SDK integration
 * in `#learn/observability/metrics` does that for each call it sees.
 *
 * The ledger rides in `AsyncLocalStorage`. Node carries it along the request's own chain of awaits and callbacks, so
 * two requests running at once each see their own, and nobody has to pass it down by hand through the rewriter, the
 * embedder, the reranker and the answer.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { Cost, TokenUsage } from "#learn/observability/prices";

export interface RequestCost {
  usd: number;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Models that ran but have no price in the table. */
  unpriced: string[];
}

const ledger = new AsyncLocalStorage<RequestCost>();

/**
 * Runs `fn` with a fresh ledger: every model call made inside it, however deep, adds its cost there. Returns what
 * `fn` returned and what the calls cost.
 */
export async function withRequestCost<T>(fn: () => Promise<T>): Promise<{ result: T; cost: RequestCost }> {
  // 🐨 Make a fresh ledger (every count 0, no unpriced models), run `fn` with it as the store, and return what
  //    `fn` returned with the ledger.
  // 🐨 The classic mistake: one ledger in a module variable, set at the start of a request and read at the end.
  //    Two chat turns run at once in one server: while Ella's answer streams, Grace's rewrite lands in Ella's
  //    total. Each request needs its own, and only AsyncLocalStorage can tell which call belongs to which.
  //
  // 💰 `ledger.run(store, fn)` returns what `fn` returns.
  //
  // 🦉 Why AsyncLocalStorage. The AI SDK calls the cost integration from inside `streamText`, `embedMany` and
  //    `rerank`, code that takes no "request" argument and never will. Node tracks which chain of async work each
  //    callback belongs to; `run` attaches the ledger to this one, so a call made three awaits deep, from any
  //    module, finds its own request's ledger. It's the same machinery OpenTelemetry uses to find the active span.
  //
  // 🚨 The tests check the result, calls deep inside, two requests interleaving, and a request that throws.
  throw new Error(`withRequestCost(${typeof fn}) isn't written yet (ledger ${typeof ledger})`);
}

/** The ledger of the request this code runs in, if any. */
export const currentRequestCost = (): RequestCost | undefined => ledger.getStore();

/** Adds one model call, and what it cost, to the ledger of the request it runs in. Outside a request, nothing. */
export function chargeRequest(call: TokenUsage & { modelId: string }, cost: Cost): void {
  // 🐨 Outside a request (a script, a test, a call before any request began), do nothing.
  // 🐨 Otherwise add to the current ledger, in place: the cost, one call, and each token count (a missing one is
  //    0). An unpriced model goes in `unpriced` once, however many calls it makes.
  //
  // 🦉 Why in place. `observeRequest` reads the ledger after the request ends, failed or not. A request that
  //    throws after three model calls still spent their money, and the span says so. Only the same object,
  //    changed as calls come in, can tell it.
  //
  // 🚨 The tests check the totals, nothing outside a request, and an unpriced model listed once.
  throw new Error(`chargeRequest(${call.modelId}, $${cost.usd}) isn't written yet`);
}
