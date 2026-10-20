---
title: Observability, done
---

# Observability, done

Kestrel's assistant now reports on itself as it runs. `inSpan` makes each step of a request a span and makes it active, so the AI SDK's own model spans nest inside: Ella's Brightwell turn is one trace of five spans. `tracedTool` puts every tool call in one, without changing the tool. Metrics in Prometheus add up tokens, cost, latency and denials, with histogram buckets where Kestrel's costs are. `costOf` prices every call from one table, and `withRequestCost` and `chargeRequest` add up a request's calls however deep they ran: $0.0002171 for Ella's answer, $0.0022171 once a Cohere search is billed. And `enqueueConversationLog`, `deliverConversationLog` and `exportConversationLog` send every turn to the warehouse through the outbox, so a slow sink never slows a chat and a crash never loses a line.

The thread: report everything that answers "what happened?", nothing that's the tenant's to keep. Spans and metrics carry ids, names, counts and costs. Prompts, replies and tool inputs stay in Postgres, under each tenant's own access.

## What to notice in the lab

Run `pnpm dev`, sign in, and open `/labs/observability`.

- **Cost per request**: the four recorded turns, priced by your code. The answers cost $0.0002 to $0.0005; with the one Cohere search a production key bills, each turn costs about ten times more, and the search is 79% to 90% of it.
- **With 19.3 active**, a stub shows its error in the panel, and a pricing mistake shows in the numbers.
- **Grafana**: the page says whether the observability stack runs and links to it. Start it (`docker compose --profile observability up -d otel-lgtm`), run `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm otel:sample`, and find Ella's trace in Tempo and the cost histogram in Prometheus (step 2 has the queries).
- **The conversation log**: set `CONVERSATION_LOG_FILE=/tmp/kestrel-conversations.jsonl` in `.env.local`, restart `pnpm dev`, ask a question, and watch the line arrive a moment after the answer. `/labs/background`'s queue board shows the `conversation_log` row go published, then claimed.

## What comes next

Section 20 is five debugging drills: a fault planted in the running app, only its symptom shown. The tools are the ones you just built and the ones before: the traces and metrics, the audit table, the queue board, the eval reports, the logs.
