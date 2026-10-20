// @vitest-environment node
import type { HistogramMetricData, SumMetricData } from "@opentelemetry/sdk-metrics";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { answer } from "#learn/generate/answer";
import { APP_K, recordedTurn, replayModel } from "#learn/generate/recorded";
import { currentRequestCost, recordDenial, recordModelCall, withRequestCost } from "#learn/observability/metrics";
import { observeRequest } from "#learn/observability/request";
import { testTelemetry } from "#learn/observability/testing";

const t = testTelemetry();
beforeAll(() => t.install());
afterAll(() => t.uninstall());

const sumOf = (m: SumMetricData | undefined, where: Record<string, unknown> = {}) =>
  (m?.dataPoints ?? [])
    .filter((p) => Object.entries(where).every(([k, v]) => p.attributes[k] === v))
    .reduce((n, p) => n + p.value, 0);

const histogramSum = (m: HistogramMetricData | undefined, where: Record<string, unknown> = {}) =>
  (m?.dataPoints ?? [])
    .filter((p) => Object.entries(where).every(([k, v]) => p.attributes[k] === v))
    .reduce((n, p) => n + (p.value.sum ?? 0), 0);

describe("model call metrics", () => {
  it("count a replayed answer's tokens, cache hits and cost, from the AI SDK's own events", async () => {
    const turn = recordedTurn("invoice-hold");
    const { cost } = await withRequestCost(async () => {
      for await (const _ of answer({
        question: turn.question,
        retrieval: { query: turn.question, rewritten: [], chunks: turn.chunks.slice(0, APP_K), auditId: "a" },
        model: replayModel("invoice-hold").model,
        reasoningEffort: "medium",
      }));
    });
    // invoice-hold: 3,907 input tokens, 303 output (164 of them reasoning), none cached.
    expect(cost).toMatchObject({ calls: 1, inputTokens: 3907, cachedInputTokens: 0, outputTokens: 303, unpriced: [] });
    expect(cost.usd).toBeCloseTo((3907 * 0.1 + 303 * 0.5) / 1e6, 10);

    const metrics = await t.readMetrics();
    const tokens = metrics.get("gen_ai.client.token.usage") as HistogramMetricData;
    expect(histogramSum(tokens, { "gen_ai.token.type": "input", "gen_ai.request.model": "gpt-6-luna" })).toBe(3907);
    expect(histogramSum(tokens, { "gen_ai.token.type": "output" })).toBe(303);
    expect(sumOf(metrics.get("agentic_chat.model.cost") as SumMetricData)).toBeCloseTo(cost.usd, 10);
    expect(metrics.get("gen_ai.client.operation.duration")).toBeDefined();
  });

  it("price cached input at the cached rate, and name a model the table doesn't know", async () => {
    const { cost } = await withRequestCost(async () => {
      recordModelCall(t.metrics, {
        provider: "openai",
        modelId: "gpt-6-luna",
        operation: "chat",
        inputTokens: 1000,
        cachedInputTokens: 800,
        outputTokens: 0,
      });
      recordModelCall(t.metrics, { provider: "lmstudio", modelId: "qwen-local", operation: "chat", inputTokens: 50 });
    });
    expect(cost.usd).toBeCloseTo((200 * 0.1 + 800 * 0.01) / 1e6, 12);
    expect(cost.unpriced).toEqual(["qwen-local"]);
    const metrics = await t.readMetrics();
    expect(sumOf(metrics.get("agentic_chat.model.cached_input_tokens") as SumMetricData)).toBe(800);
  });

  it("keeps each request's ledger to itself, however the requests interleave", async () => {
    const call = (tokens: number) =>
      recordModelCall(t.metrics, { provider: "openai", modelId: "gpt-6-luna", operation: "chat", inputTokens: tokens });
    const pause = () => new Promise((r) => setTimeout(r, 5));
    const [a, b] = await Promise.all([
      withRequestCost(async () => {
        call(100);
        await pause();
        call(100);
      }),
      withRequestCost(async () => {
        await pause();
        call(7);
      }),
    ]);
    expect([a.cost.inputTokens, b.cost.inputTokens]).toEqual([200, 7]);
    expect(currentRequestCost()).toBeUndefined();
  });
});

describe("request and denial metrics", () => {
  it("record a request's latency and cost by route and status, an error included", async () => {
    await observeRequest(t, { route: "chat_turn" }, async () => "complete");
    await expect(
      observeRequest(t, { route: "chat_turn" }, async () => {
        recordModelCall(t.metrics, {
          provider: "openai",
          modelId: "gpt-6-luna",
          operation: "chat",
          inputTokens: 10000,
        });
        throw new Error("model down");
      }),
    ).rejects.toThrow("model down");
    const metrics = await t.readMetrics();
    const duration = metrics.get("agentic_chat.request.duration") as HistogramMetricData;
    expect(duration.dataPoints.map((p) => [p.attributes["agentic_chat.status"], p.value.count])).toEqual([
      ["ok", 1],
      ["error", 1],
    ]);
    // The failed request still reports what it spent before failing.
    expect(
      histogramSum(metrics.get("agentic_chat.request.cost") as HistogramMetricData, { "agentic_chat.status": "error" }),
    ).toBeCloseTo(0.001);
  });

  it("count denials by kind, and nothing for a count of 0", async () => {
    recordDenial(t.metrics, "acl", 3);
    recordDenial(t.metrics, "acl", 0);
    recordDenial(t.metrics, "rate_limit");
    const denials = (await t.readMetrics()).get("agentic_chat.denials") as SumMetricData;
    expect(sumOf(denials, { "agentic_chat.denial.kind": "acl" })).toBe(3);
    expect(sumOf(denials, { "agentic_chat.denial.kind": "rate_limit" })).toBe(1);
  });
});
