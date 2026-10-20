---
title: OpenTelemetry GenAI spans
type: graded
slots:
  observability/spans: spans.ts
---

# OpenTelemetry GenAI spans: the solution

`inSpan` hands its work to `tracer.startActiveSpan(name, { kind, attributes }, async (span) => ...)`. Inside, a `try` awaits `fn(span)` and returns its result; the `catch` records the exception, sets the status to error with the message, and rethrows; the `finally` ends the span. `tracedTool` spreads the tool and replaces only `execute`, which calls the tool's own `execute` inside `inSpan` with the `execute_tool <name>` span and its six attributes.

## Why it works

- **Active is what makes a tree.** OpenTelemetry keeps "the span running now" in a context that Node carries through every `await` and callback of a request (AsyncLocalStorage, the same machinery as step 3's ledger). `startActiveSpan` puts your span there while `fn` runs, so the AI SDK, which starts its spans deep inside `streamText`, finds it as their parent. `startSpan` alone makes an orphan, and the model call lands in a trace of its own.
- **Spans, not log lines.** A log line is a point in time with some text. A span is an interval with a parent: the trace shows what ran inside what, in order, and what overlapped. "Where did nine seconds go?" is a look at one tree instead of a search through thousands of lines for the ones that belong together.
- **An error span is still a result.** `inSpan` marks the span and rethrows, so the trace shows which call failed and the caller behaves exactly as it would untraced. Section 13's loop still turns the throw into an `ok: false` result for the model.
- **The tool is unchanged.** Spreading keeps `needsApproval`, the schema and the effect, which the loop and the policy read. Tracing must never change what the app does.
- **What stays off a span.** Prompts, replies and tool inputs hold tenant documents and mail bodies. The spans carry ids, names, counts and costs; the content stays in Postgres under the tenant's own access, and `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` turns the AI SDK's content capture on only when someone asks.

## The worked example

Ella's turn is five spans in one trace: `chat_turn` ($0.0002171, one model call, 1,776 tokens in and 79 out) with `retrieval chunks` (8 chunks, 3 rewrites) and the AI SDK's `invoke_agent gpt-6-luna`, `step 1` and `chat gpt-6-luna` inside it. The same five arrive in Tempo from `pnpm otel:sample`.

## A durable run has no single span

An agent run (section 15) can wait a week for an approval and resume in another process. A span has to start and end in one process, so a run is many traces, one per step: `invoke_agent kestrel-assistant`, each carrying the run id as `gen_ai.agent.id`. A search on that attribute lines the steps up.

💯 Store the first step's trace context on the run row (`propagation.inject` into a carrier), and start every later step with a link to it (`links` in the span options), so Tempo can join a run's steps across processes.
