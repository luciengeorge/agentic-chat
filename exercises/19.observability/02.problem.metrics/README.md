---
title: Metrics and dashboards
type: guided
---

# Metrics and dashboards

👨‍💼 Step 1's traces answer "what happened in this one request". Kestrel's on-call engineer asks different questions: how many tokens an hour, what share served from the cache, what a chat turn costs at the 95th percentile, how many chunks the ACL withheld today. Keeping every trace to add them up would cost more than the chats. Metrics add the numbers up as they happen, and a dashboard draws them.

## Terms

- **Prometheus** stores metrics as **time series**: a name, a set of **labels** (`gen_ai_token_type="input"`), and a value over time. **PromQL** is its query language.
- The local stack turns OpenTelemetry names into Prometheus ones: dots become underscores, the unit becomes a suffix (`agentic_chat.request.cost` in USD is `agentic_chat_request_cost_USD`), and a counter ends in `_total`.
- A histogram is stored as three series: `_bucket` (how many values fell at or under each boundary `le`), `_sum` and `_count`.
- `rate(x[5m])` is how fast a counter grew per second over the last five minutes. `histogram_quantile(0.95, ...)` estimates the value under which 95% of the observations fall, from the buckets.
- **Cardinality** is how many different label combinations a metric has. Each one is a separate series to store.

## Do this

1. 🐨 Start the stack (the image is 3.5 GB the first time) and send it four chat turns. `pnpm otel:sample` replays the recorded turns of section 10 with telemetry on: no dev server, database or model call.
   ```sh
   docker compose --profile observability up -d otel-lgtm
   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm otel:sample
   ```
2. 🐨 Open Grafana on http://localhost:3001 (admin, admin), then **Explore**, **Tempo**, and search for service `agentic-chat`. Open Ella's Brightwell trace: the five spans of step 1.
3. 🐨 Switch Explore to **Prometheus** and run these, one at a time. Write down what each returns.
   ```promql
   sum by (gen_ai_token_type) (gen_ai_client_token_usage_sum)
   sum(agentic_chat_model_cost_USD_total)
   sum by (le) (agentic_chat_request_cost_USD_bucket)
   histogram_quantile(0.5, sum by (le) (agentic_chat_request_cost_USD_bucket))
   histogram_quantile(0.95, sum by (le) (agentic_chat_request_cost_USD_bucket))
   ```
   The four turns cost $0.0002171, $0.0005422, $0.0002411 and $0.0003317. Is the median Prometheus gives you the real median? Why not?
4. 🐨 Build a dashboard (**Dashboards**, **New**, **Add visualization**) with three panels: tokens per second by type, `sum by (gen_ai_token_type) (rate(gen_ai_client_token_usage_sum[5m]))`; cost per chat turn at the 95th percentile, `histogram_quantile(0.95, sum by (le) (rate(agentic_chat_request_cost_USD_bucket[5m])))`; and chunks the ACL withheld, `sum by (agentic_chat_denial_kind) (agentic_chat_denials_total)` (empty until something is denied). Run `pnpm otel:sample` again and watch them move.
5. 🐨 Read `createMetrics` and `modelCallMetrics` in `src/core/observability/metrics.ts`, and answer:
   - Why is a model call's cost a counter, and a request's cost a histogram?
   - Why do the request cost buckets run from $0.0001 to $0.05, and not the SDK's default boundaries (0, 5, 10, 25, ... 10,000)?
   - Why is the token type a label on one metric, and not two metrics?
   - Why is there no `user_id` label anywhere, though "cost per user" would be useful?
6. 🐨 To watch the real app, add `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` to `.env.local`, restart `pnpm dev`, and ask a few questions in the chat. Remove it again when you're done: with it unset, nothing is registered and the app runs exactly as before.

🦉 Why metrics, when you have traces. A trace is one request in full detail; keeping all of them for a busy app is expensive, so production systems keep a sample. A metric is a running total, the same few numbers per series whatever the traffic, so it's cheap to keep for months. A histogram keeps buckets instead of a single average because percentiles can't be added up: the 95th percentile of two servers isn't the average of their two 95th percentiles, but their bucket counts do add, and the percentile is worked out after.

When you're done: `docker compose --profile observability stop otel-lgtm`.

📜 [OpenTelemetry's GenAI metrics](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/), and [Prometheus histograms](https://prometheus.io/docs/practices/histograms/)
