---
title: Observability
---

# Observability

Section 18 tells Kestrel whether a version of the assistant is good, before it ships. Once it runs, the questions change. Why was Grace's answer slow this morning? Which part of a chat turn takes the time: retrieval, the rewrite, the model? What does a turn cost, and is that going up? How many chunks did the ACL withhold today? **Observability** is the app reporting enough about itself, as it runs, to answer questions nobody thought to ask in advance.

This section adds it the standard way, with **OpenTelemetry**: spans for every step of a request, metrics for what adds up over time, a cost for every request from one price table, and a log of every conversation sent out through the outbox. The AI SDK already reports its own model calls; the app adds the rest. Everything is off until a collector is configured, so with nothing set the app runs exactly as before.

## Terms

- **OpenTelemetry** (OTel) is the open standard for how an app reports traces and metrics, and the libraries that do it. **OTLP** is its wire format; a **collector** receives it.
- A **span** is one timed piece of work: a name, a start, an end, attributes (facts about it), and a parent. A **trace** is the tree of spans for one request.
- The **GenAI semantic conventions** are OpenTelemetry's agreed names for AI work: a span called `chat gpt-6-luna` with `gen_ai.usage.input_tokens`, `execute_tool search_documents` with `gen_ai.tool.name`. Any tool that knows the conventions can read them.
- A **metric** is a number added up over time: a **counter** only goes up (tokens, dollars), a **histogram** keeps the spread of a value in **buckets** (how many requests cost under $0.0005, under $0.001...).
- **Cost per request** is what one chat turn's model calls cost together, from their token counts and a **price table**.
- The **conversation log** is every finished chat turn as one line of JSON, sent to a **sink** (a file here; a bucket or a warehouse in production).
- **grafana/otel-lgtm** is one container with a collector, Tempo (traces), Prometheus (metrics), Loki (logs) and Grafana to look at them. It runs under the `observability` Compose profile.

## The steps

1. **OpenTelemetry GenAI spans** (`observability/spans`: `inSpan`, `tracedTool`). One trace per chat turn, with the AI SDK's model spans inside yours.
2. **Metrics and dashboards** (guided). The local stack, Kestrel's metrics in Prometheus, and a dashboard of tokens, cost and latency.
3. **Cost per request** (`observability/prices`: `costOf`; `observability/ledger`: `withRequestCost`, `chargeRequest`). Every model call priced from one table, and added up per request however deep it ran.
4. **Conversation log fan-out** (`observability/conversation-log`: `enqueueConversationLog`, `exportConversationLog`, `deliverConversationLog`). Each turn logged through the outbox, so a slow sink never slows a chat.

Steps 1 and 3 need nothing running: they replay the four chat turns recorded in section 10. Step 4 needs Postgres (`pnpm ex up`). Step 2 needs the observability stack:

```sh
docker compose --profile observability up -d otel-lgtm
```

The lab, `/labs/observability`, prices the recorded turns with your code and links to Grafana on http://localhost:3001 while the stack runs.
