// 👨‍💼 Every cost Kestrel reports (a chat turn's, an eval run's, the dashboard's dollars per hour) is worked out
//    in this file, from the usage the provider reported and one price table. A price change is one edit here.
//
// 🦉 Already written in this file: `PRICES` and `priceKey`. You write `costOf`.

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
  // 🐨 Find the model's price with `priceKey`. No price: cost 0, `priced: false`.
  // 🐨 A search price: that's the cost, whatever the usage says.
  // 🐨 A token price: the fresh input (input minus cached) at `input`, the cached tokens at `cachedInput`, the
  //    output at `output`, all per million. A missing count is 0, and never count more cached tokens than input.
  // 🐨 The classic mistake: pricing all the input at the fresh rate and the cached tokens again on top. Cached
  //    tokens are part of `inputTokens`. 10,000 input with 4,000 cached is 6,000 fresh and 4,000 cached.
  //
  // 💰 `"perSearch" in price` tells the two kinds of price apart. `Math.min`.
  //
  // 🦉 Why `priced: false` and never just 0. A local model (section 21) or a new one nobody added to the table
  //    costs something, or nothing, and the table can't say which. A silent 0 would make a request look free and
  //    hide that the table is out of date. The ledger lists unpriced models, so a report can say so.
  // 🦉 Why the provider's usage, not your own count. Section 01 counted tokens with o200k_base, and the provider's
  //    own count differs by a few tokens a call (message framing, tool specs). The bill uses the provider's
  //    count, so the cost does too.
  //
  // 🚨 The tests check fresh, cached and output, the cache never above the input, embeddings, a rerank, an
  //    unknown model, and section 18's 59 recorded calls.
  throw new Error(`costOf(${JSON.stringify(modelId)}, ${JSON.stringify(usage)}) isn't written yet`);
}
