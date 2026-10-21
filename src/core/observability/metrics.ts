/**
 * Metrics: numbers added up over time, where a span describes one request. A dashboard asks "how many tokens an
 * hour, what share from the cache, what does a chat turn cost at the 95th percentile", and metrics answer without
 * keeping every trace.
 *
 * Two kinds here. A counter only goes up (tokens, dollars, denials). A histogram keeps the spread of a value (how
 * long a call took, what a request cost), so a dashboard can draw its median and its tail.
 *
 * - `gen_ai.client.token.usage` and `gen_ai.client.operation.duration` are the GenAI conventions' own metrics.
 * - `agentic_chat.*` are this app's: cached input tokens, cost, request latency and cost, and denials.
 *
 * Model calls are counted by an AI SDK telemetry integration (`modelCallMetrics`), so every call (the chat answer,
 * the query rewriter, the embedder, the reranker, the agent's turns) is counted once, wherever it's made. A request
 * adds up its own cost in a ledger (`#learn/observability/ledger`) that every model call inside it writes to.
 */
import type { Telemetry } from "ai";

import { type Attributes, type Counter, type Histogram, type Meter } from "@opentelemetry/api";

import { chargeRequest, type RequestCost } from "#learn/observability/ledger";
import { costOf } from "#learn/observability/prices";
import { GEN_AI } from "#learn/observability/spans";

export { currentRequestCost, type RequestCost, withRequestCost } from "#learn/observability/ledger";

export interface AppMetrics {
  tokenUsage: Histogram;
  operationDuration: Histogram;
  cachedInputTokens: Counter;
  costUsd: Counter;
  requestDuration: Histogram;
  requestCostUsd: Histogram;
  denials: Counter;
}

export function createMetrics(meter: Meter): AppMetrics {
  return {
    tokenUsage: meter.createHistogram("gen_ai.client.token.usage", {
      unit: "{token}",
      description: "Tokens per model call, by gen_ai.token.type (input or output)",
      advice: { explicitBucketBoundaries: [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144] },
    }),
    operationDuration: meter.createHistogram("gen_ai.client.operation.duration", {
      unit: "s",
      description: "How long each model call took",
      advice: { explicitBucketBoundaries: [0.01, 0.04, 0.16, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92] },
    }),
    cachedInputTokens: meter.createCounter("agentic_chat.model.cached_input_tokens", {
      unit: "{token}",
      description: "Input tokens served from the provider's prompt cache",
    }),
    costUsd: meter.createCounter("agentic_chat.model.cost", { unit: "USD", description: "What model calls cost" }),
    requestDuration: meter.createHistogram("agentic_chat.request.duration", {
      unit: "s",
      description: "How long a chat turn or an agent step took, end to end",
    }),
    requestCostUsd: meter.createHistogram("agentic_chat.request.cost", {
      unit: "USD",
      description: "What one request's model calls cost together",
      advice: { explicitBucketBoundaries: [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05] },
    }),
    denials: meter.createCounter("agentic_chat.denials", {
      description: "Things refused: chunks the ACL withheld, requests rate-limited, tool calls the policy blocked",
    }),
  };
}

export interface ModelCall {
  provider: string;
  modelId: string;
  /** chat, embeddings or rerank. */
  operation: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

/** Records one model call: its tokens, cache hits, cost and duration, and adds its cost to the request's ledger. */
export function recordModelCall(metrics: AppMetrics, call: ModelCall): number {
  const attributes: Attributes = {
    [GEN_AI.operation]: call.operation,
    [GEN_AI.provider]: call.provider,
    [GEN_AI.requestModel]: call.modelId,
  };
  if (call.inputTokens !== undefined)
    metrics.tokenUsage.record(call.inputTokens, { ...attributes, [GEN_AI.tokenType]: "input" });
  if (call.outputTokens !== undefined)
    metrics.tokenUsage.record(call.outputTokens, { ...attributes, [GEN_AI.tokenType]: "output" });
  if (call.cachedInputTokens) metrics.cachedInputTokens.add(call.cachedInputTokens, attributes);
  if (call.durationMs !== undefined) metrics.operationDuration.record(call.durationMs / 1000, attributes);
  const cost = costOf(call.modelId, call);
  if (cost.priced) metrics.costUsd.add(cost.usd, attributes);
  chargeRequest(call, cost);
  return cost.usd;
}

/**
 * An AI SDK telemetry integration that records every model, embedding and rerank call the SDK makes. Registered
 * beside the OpenTelemetry one, it sees the same calls, so nothing has to pass usage around by hand.
 */
export function modelCallMetrics(metrics: AppMetrics): Telemetry {
  return {
    onLanguageModelCallEnd(event) {
      recordModelCall(metrics, {
        provider: event.provider,
        modelId: event.modelId,
        operation: "chat",
        inputTokens: event.usage.inputTokens,
        cachedInputTokens: event.usage.inputTokenDetails?.cacheReadTokens,
        outputTokens: event.usage.outputTokens,
        durationMs: event.performance?.responseTimeMs,
      });
    },
    onEmbedEnd(event) {
      recordModelCall(metrics, {
        provider: event.provider,
        modelId: event.modelId,
        operation: "embeddings",
        inputTokens: event.usage.tokens,
      });
    },
    onRerankEnd(event) {
      recordModelCall(metrics, { provider: event.provider, modelId: event.modelId, operation: "rerank" });
    },
  };
}

export type DenialKind = "acl" | "rate_limit" | "policy";

/** Something was refused: chunks the ACL withheld from a retrieval, a rate-limited request, a blocked tool call. */
export function recordDenial(metrics: AppMetrics, kind: DenialKind, count = 1): void {
  if (count > 0) metrics.denials.add(count, { "agentic_chat.denial.kind": kind });
}

/** A whole request: how long it took and, from its ledger, what it cost. */
export function recordRequest(
  metrics: AppMetrics,
  request: { route: string; durationMs: number; status: string; cost?: RequestCost },
): void {
  const attributes = { "agentic_chat.route": request.route, "agentic_chat.status": request.status };
  metrics.requestDuration.record(request.durationMs / 1000, attributes);
  if (request.cost) metrics.requestCostUsd.record(request.cost.usd, attributes);
}
