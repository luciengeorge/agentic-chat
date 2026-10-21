---
title: Cost per request
type: graded
slots:
  observability/prices: prices.ts
  observability/ledger: ledger.ts
---

# Cost per request: the solution

`costOf` finds the model with `priceKey`; none means `{ usd: 0, priced: false }`. A search price is the cost as it stands. A token price splits the input: `cached = min(cachedInputTokens, inputTokens)` at the cached rate, the rest at the fresh rate, the output at the output rate, all over a million. `withRequestCost` makes an empty ledger, runs `fn` with `ledger.run(cost, fn)`, and returns `{ result, cost }`. `chargeRequest` reads `currentRequestCost()`, returns when there's none, and adds the call to it in place, putting an unpriced model's id in `unpriced` once.

## Why it works

- **One table, one function.** Every cost in the app goes through `costOf`: the request metric, the span, `pnpm eval`'s totals, this lab. When gpt-6-luna's price changes, one line changes and every report agrees.
- **Cached tokens are a part of the input, not more of it.** The provider reports 10,000 input, 4,000 of them cached, and 1,000 output; it bills 6,000 fresh, 4,000 at a tenth and the 1,000 output. Pricing all 10,000 fresh and then the 4,000 again gives $0.00154 instead of $0.00114: 35% too much on every call of that shape.
- **Unpriced is not free.** A missing price is a fact about the table, so it's reported, never hidden in a 0.
- **The ledger finds its own request.** `ledger.run` ties the ledger to one chain of async work. The AI SDK fires its telemetry callback deep inside `streamText` or `rerank`, from code that knows nothing of requests, and `getStore()` there still returns the ledger of the request that started the call. Two requests interleaving each see their own; a module variable would hand Grace's rewrite to Ella's turn.
- **In place, so failures still count.** `observeRequest` keeps a reference to the ledger and reads it when the request ends, thrown or not. A request that spent $0.001 and then failed reports $0.001.

## The worked example

The four recorded answers: $0.0002171, $0.0005422, $0.0002411, $0.0003317. Ella's turn plus one Cohere search: $0.0022171, of which the search is $0.002. On a production Cohere key, the reranker is about 90% of a chat turn's bill; the rewrite and the query embedding add a few hundredths of a cent more (the M1 eval averaged about $0.00036 a question without the rerank). Section 18's 59 recorded calls: $0.013408, $0.00067 less than with no cache discount.

## Where it goes

`observeRequest` puts the ledger on the turn's span (`agentic_chat.request.cost_usd`) and in the `agentic_chat.request.cost` histogram (step 2's p95). `pnpm eval` prices its runs with `costOf`. The lab, `/labs/observability`, prices the recorded turns with your code.
