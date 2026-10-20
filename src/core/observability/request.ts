/**
 * One request seen whole: a span around it, the cost of every model call inside it added up, and its latency and
 * cost recorded as metrics. The chat route wraps each turn in it, the agent runner each step.
 */
import type { Attributes, Span, Tracer } from "@opentelemetry/api";

import {
  type AppMetrics,
  currentRequestCost,
  recordRequest,
  type RequestCost,
  withRequestCost,
} from "#learn/observability/metrics";
import { inSpan } from "#learn/observability/spans";

export interface ObservedRequest<T> {
  /** Names the span and the metrics' `agentic_chat.route`: "chat_turn", "agent_step". */
  route: string;
  attributes?: Attributes;
  /** The status of a request that returned: "ok" unless this says otherwise ("aborted", for a chat the client left). */
  statusOf?: (result: T) => string;
}

/**
 * Runs `fn` as one observed request. The span gets the request's cost and tokens when it ends, failed or not; the
 * metrics get its duration and cost, with its status ("ok", "aborted", or "error" when it threw).
 */
export async function observeRequest<T>(
  telemetry: { tracer: Tracer; metrics: AppMetrics },
  request: ObservedRequest<T>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const started = performance.now();
  return inSpan(telemetry.tracer, request.route, request.attributes ?? {}, async (span) => {
    let status = "error";
    // Kept by reference, so a request that fails still reports what it spent before failing.
    let cost: RequestCost | undefined;
    try {
      const { result } = await withRequestCost(() => {
        cost = currentRequestCost();
        return fn(span);
      });
      status = request.statusOf?.(result) ?? "ok";
      return result;
    } finally {
      const spent = cost as RequestCost | undefined;
      span.setAttribute("agentic_chat.status", status);
      if (spent) {
        span.setAttributes({
          "agentic_chat.request.cost_usd": spent.usd,
          "agentic_chat.request.model_calls": spent.calls,
          "gen_ai.usage.input_tokens": spent.inputTokens,
          "gen_ai.usage.cache_read.input_tokens": spent.cachedInputTokens,
          "gen_ai.usage.output_tokens": spent.outputTokens,
        });
      }
      recordRequest(telemetry.metrics, {
        route: request.route,
        durationMs: performance.now() - started,
        status,
        cost: spent,
      });
    }
  });
}
