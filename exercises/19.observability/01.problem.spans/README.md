---
title: OpenTelemetry GenAI spans
type: graded
slots:
  observability/spans: spans.ts
---

# OpenTelemetry GenAI spans

👨‍💼 Grace says the assistant took nine seconds to answer this morning. The server's log has one line for her turn, "chat turn finished in 9,120 ms", and nothing about where the time went. Retrieval? The query rewrite? The model? A tool the agent called? To know, every step of a request has to report its own start and end, and say which step it ran inside. That's a span, and a request's spans make a trace.

## Terms

- A **span** has a name, a start and an end, **attributes** (`gen_ai.request.model: gpt-6-luna`), a **status** (unset, or error), and a **parent**: the span that was running when it started. The spans of one request share a **trace id**.
- The **active span** is the one current code runs inside. A span started while another is active becomes its child. `tracer.startActiveSpan(name, options, fn)` starts a span and makes it active while `fn` runs.
- An **exception event** is recorded on a span with `span.recordException(error)`; `span.setStatus({ code: SpanStatusCode.ERROR, message })` marks it failed.
- The AI SDK makes its own spans for every model call once its OpenTelemetry integration is registered (`#learn/observability/setup`): `invoke_agent gpt-6-luna` for a `streamText` call, with `step 1` and `chat gpt-6-luna` inside. The app wraps them in its own.

## Do this

🐨 In `playground/spans.ts`, write `inSpan` (run a function inside a new active span) and `tracedTool` (one tool, with an `execute_tool <name>` span around every call). `tracedRetrieve` and `agentStep` are written; both call your `inSpan`.

## A worked example

Ella Brooks asks about the Brightwell launch (section 10's recording). With your `inSpan`, the chat turn's trace is five spans in one tree:

```
chat_turn                       cost $0.0002171, 1 model call
├─ retrieval chunks             8 chunks returned, 3 rewrites
└─ invoke_agent gpt-6-luna      the AI SDK's streamText call
   └─ step 1
      └─ chat gpt-6-luna        1,776 input tokens, 79 output
```

`chat_turn` comes from `observeRequest`, `retrieval chunks` from `tracedRetrieve`, and the other three from the AI SDK. They nest only because your `inSpan` makes each span active while its work runs. The same tree arrives in Grafana's Tempo from `pnpm otel:sample` (step 2). The last test builds it from the recording and checks every parent.

Run the tests with `pnpm ex test 19.1`.
