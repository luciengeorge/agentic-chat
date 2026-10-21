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

const emptyCost = (): RequestCost => ({
  usd: 0,
  calls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  unpriced: [],
});

/**
 * Runs `fn` with a fresh ledger: every model call made inside it, however deep, adds its cost there. Returns what
 * `fn` returned and what the calls cost.
 */
export async function withRequestCost<T>(fn: () => Promise<T>): Promise<{ result: T; cost: RequestCost }> {
  const cost = emptyCost();
  const result = await ledger.run(cost, fn);
  return { result, cost };
}

/** The ledger of the request this code runs in, if any. */
export const currentRequestCost = (): RequestCost | undefined => ledger.getStore();

/** Adds one model call, and what it cost, to the ledger of the request it runs in. Outside a request, nothing. */
export function chargeRequest(call: TokenUsage & { modelId: string }, cost: Cost): void {
  const request = currentRequestCost();
  if (!request) return;
  request.usd += cost.usd;
  request.calls += 1;
  request.inputTokens += call.inputTokens ?? 0;
  request.cachedInputTokens += call.cachedInputTokens ?? 0;
  request.outputTokens += call.outputTokens ?? 0;
  if (!cost.priced && !request.unpriced.includes(call.modelId)) request.unpriced.push(call.modelId);
}
