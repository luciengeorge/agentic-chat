---
title: Cost per request
type: graded
slots:
  observability/prices: prices.ts
  observability/ledger: ledger.ts
---

# Cost per request

👨‍💼 Kestrel's finance team asks what a chat turn costs, and whether the agent is worth what it spends. The provider's invoice says what the month cost, all of it in one line. To know what one request costs, every model call has to be priced as it happens and charged to the request it ran for. A chat turn makes several: a query rewrite, an embedding, a rerank and the answer, each from a different place in the code.

## Terms

- Providers bill **per million tokens**, in US dollars, at three rates: fresh **input**, **cached input** (a prompt prefix the provider saw minutes ago, a tenth of the price), and **output** (reasoning tokens included). A reranker bills **per search**.
- `PRICES` in `prices.ts` is Kestrel's one **price table**: gpt-6-luna at $0.10, $0.01 and $0.50; text-embedding-3-small at $0.02; Cohere's rerank at $0.002 a search. `priceKey` finds a model in it however the provider names it (`openai.responses:gpt-6-luna`).
- A model call's **usage** is what the provider reported: `inputTokens` (cached ones included), `cachedInputTokens`, `outputTokens`.
- A **ledger** holds one request's running total: dollars, calls, tokens, and any model the table has no price for. `withRequestCost(fn)` opens one; `chargeRequest(call, cost)` adds a call to the ledger of the request it runs in.
- **AsyncLocalStorage** (`node:async_hooks`) keeps a value for one chain of async work: whatever runs inside `storage.run(value, fn)`, through every `await`, sees `value` from `storage.getStore()`, and code running for another request sees its own.

## Do this

🐨 In `playground/prices.ts`, write `costOf`. In `playground/ledger.ts`, write `withRequestCost` and `chargeRequest`. The AI SDK integration in `#learn/observability/metrics` calls both for every call the SDK makes.

## A worked example

Ella's Brightwell answer sent 1,776 input tokens, none cached, and got 79 back: 1,776 × $0.10 + 79 × $0.50 = $0.0001776 + $0.0000395 = **$0.0002171**. The other recorded turns cost $0.0005422 (Grace, 3,907 and 303), $0.0002411 (Leo's London hotel, 1,641 and 154) and $0.0003317 (Leo's Heron, 2,777 and 108).

Add one Cohere rerank to Ella's turn and the request costs **$0.0022171**: two calls, and the rerank is 90% of it. The token bill isn't always the bill.

Cached tokens matter at scale: section 18's 59 judge and claim calls sent 107,031 input tokens, 7,447 of them cached, and 6,751 output: **$0.013408**, against $0.014079 with no cache discount. The last tests replay all of it through your code.

Run the tests with `pnpm ex test 19.3`.
