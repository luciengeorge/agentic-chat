/**
 * What a model call costs, from its usage and one price table. Every cost the app reports (the request cost
 * metric, `pnpm eval`'s totals, the eval scripts) is worked out here, so a price change is one edit.
 *
 * Providers bill by the token, in US dollars per million. A cached input token (a prompt prefix the provider has
 * seen in the last few minutes) is billed at a tenth of a fresh one. Reasoning tokens are output tokens, already
 * counted in `outputTokens`. A reranker bills per search, whatever the length.
 */

export interface TokenPrice {
  /** USD per million fresh input tokens. */
  input: number;
  /** USD per million cached input tokens. */
  cachedInput: number;
  /** USD per million output tokens, reasoning included. */
  output: number;
}

export interface SearchPrice {
  /** USD per rerank call. */
  perSearch: number;
}

/** List prices, October 2026. A model missing here costs 0 and is reported as unpriced (a local model, a fake). */
export const PRICES: Record<string, TokenPrice | SearchPrice> = {
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 },
  "text-embedding-3-small": { input: 0.02, cachedInput: 0.02, output: 0 },
  // Cohere bills $2 per 1,000 searches on a production key; a trial key bills nothing.
  "rerank-v4.0-fast": { perSearch: 0.002 },
  "rerank-v4.0-pro": { perSearch: 0.002 },
};

export interface TokenUsage {
  inputTokens?: number;
  /** The part of `inputTokens` read from the provider's cache. */
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface Cost {
  usd: number;
  /** False when the model isn't in the table, so `usd` is 0 for want of a price, not because it was free. */
  priced: boolean;
}

/** A model id as providers report it ("openai.responses:gpt-6-luna", "gpt-6-luna-2026-09-01") to its table key. */
export function priceKey(modelId: string): string | null {
  const bare = modelId.slice(modelId.lastIndexOf(":") + 1);
  if (bare in PRICES) return bare;
  return Object.keys(PRICES).find((key) => bare.startsWith(`${key}-`)) ?? null;
}

/** The cost of a model call with this usage. Cached tokens are priced as cached, the rest of the input as fresh. */
export function costOf(modelId: string, usage: TokenUsage): Cost {
  const key = priceKey(modelId);
  if (!key) return { usd: 0, priced: false };
  const price = PRICES[key];
  if ("perSearch" in price) return { usd: price.perSearch, priced: true };
  const input = usage.inputTokens ?? 0;
  const cached = Math.min(usage.cachedInputTokens ?? 0, input);
  const usd =
    ((input - cached) * price.input + cached * price.cachedInput + (usage.outputTokens ?? 0) * price.output) / 1e6;
  return { usd, priced: true };
}
