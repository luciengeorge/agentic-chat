---
title: Metrics and dashboards
type: guided
---

# Metrics and dashboards: what the stack shows

## The sample, in numbers

`pnpm otel:sample` prints a trace id and a cost per turn: Brightwell (ella.brooks) $0.0002171, invoice hold (grace.adeyemi) $0.0005422, London hotel (leo.martin) $0.0002411, Heron (leo.martin) $0.0003317. Then, in Prometheus:

| Query                                                        | Result                                         |
| ------------------------------------------------------------ | ---------------------------------------------- |
| `sum by (gen_ai_token_type) (gen_ai_client_token_usage_sum)` | input 10,101, output 644                       |
| `sum(agentic_chat_model_cost_USD_total)`                     | 0.0013321                                      |
| `sum by (le) (agentic_chat_request_cost_USD_bucket)`         | 0 at 0.0002, 3 at 0.0005, 4 at 0.001 and above |
| `histogram_quantile(0.5, ...)`                               | 0.0004                                         |
| `histogram_quantile(0.95, ...)`                              | 0.0009                                         |

**The median isn't the real one.** The real median of the four costs is $0.000286 (halfway between $0.000241 and $0.000332), and the most any turn cost is $0.000542. Prometheus never saw the values, only the bucket counts: three turns between $0.0002 and $0.0005, one between $0.0005 and $0.001. It assumes the values inside a bucket are spread evenly and reads across. The median is the 2nd of 4, two thirds of the way into a bucket of three: 0.0002 + 0.0003 × 2/3 = 0.0004. The 95th percentile is 0.8 of the way into the last bucket: 0.0009. A histogram is only as exact as its buckets are narrow, which is why their boundaries are chosen with care.

## The questions

- **Counter for a call, histogram for a request.** What every call costs, added up, is the spend: a running total, and `rate` turns it into dollars per second. For a request the question is the spread (what a usual turn costs, what a bad one costs), so its cost is recorded as one observation in a histogram.
- **Buckets from $0.0001 to $0.05.** A chat turn costs a few hundredths of a cent: $0.0002 to $0.0006 for the answer, about $0.0022 once a Cohere rerank is billed (step 3). The SDK's default boundaries start at 0 and go to 5 and then 10, so every turn would fall in the first bucket and every percentile would read the same. The boundaries sit where the values are, roughly doubling.
- **One metric with a token type label.** `sum(...)` gives all tokens, `sum by (gen_ai_token_type) (...)` splits input from output, and the GenAI conventions name the label, so any dashboard built for the conventions reads it. Two metrics would need two queries and a sum by hand.
- **No `user_id` label.** Every distinct set of labels is its own series, and a histogram has a series per bucket. Thousands of users, times routes, statuses and 10 buckets, is a series explosion: memory, storage and slow queries. Who spent what lives where it's cheap to look up one at a time: the daily budget table (section 13) and the conversation log (step 4). Metrics keep labels with a few values: route, status, model, token type, denial kind.

## The real app

With `OTEL_EXPORTER_OTLP_ENDPOINT` in `.env.local`, a chat turn's trace has more spans than the sample's five. The query rewrite, the embedding of the question and its rewrites, and the rerank are AI SDK calls too, so each gets its own span under `chat_turn`, and each is counted in `gen_ai_client_token_usage` and priced in `agentic_chat_model_cost_USD_total`. Chunks the ACL withheld show in `agentic_chat_denials_total{agentic_chat_denial_kind="acl"}`, and a rate-limited request as `rate_limit`.

## In an interview

"Traces for one request, metrics for everything added up. We follow OpenTelemetry's GenAI conventions, so the AI SDK's model spans nest inside ours, and the token and duration metrics are the standard ones. Request cost is a histogram with buckets where our costs are, since the default boundaries would put every request in the first bucket and the percentiles would mean nothing. We keep labels to a few values each, no user ids, because cardinality is what makes a metrics bill explode; per-user cost lives in Postgres."
