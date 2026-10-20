// @vitest-environment node
import { SpanStatusCode } from "@opentelemetry/api";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { AgentTool } from "#learn/agent/types";
import type { Retrieve } from "#learn/retrieve/types";

import { answer } from "#learn/generate/answer";
import { APP_K, recordedTurn, replayModel } from "#learn/generate/recorded";
import { costOf } from "#learn/observability/prices";
import { observeRequest } from "#learn/observability/request";
import { agentStep, tracedRetrieve, tracedTool } from "#learn/observability/spans";
import { testTelemetry } from "#learn/observability/testing";

const t = testTelemetry();
const viewer = { tenantId: "t1", userId: "u1" };

beforeAll(() => t.install());
afterAll(() => t.uninstall());
beforeEach(() => t.resetSpans());

const named = (name: string) => t.spans().filter((s) => s.name === name);

/** A chat turn as the route runs it, on the recorded Brightwell turn (ella.brooks): retrieval, then the answer. */
async function brightwellTurn() {
  const turn = recordedTurn("brightwell");
  const retrieve: Retrieve = async (_viewer, query) => ({
    query,
    rewritten: turn.rewritten,
    chunks: turn.chunks.slice(0, APP_K),
    auditId: "audit-1",
  });
  return observeRequest(t, { route: "chat_turn", attributes: { "gen_ai.conversation.id": "conv-1" } }, async () => {
    const retrieval = await tracedRetrieve(t.tracer, retrieve)(viewer, turn.question);
    for await (const _ of answer({
      question: turn.question,
      retrieval,
      model: replayModel("brightwell").model,
      reasoningEffort: "medium",
    }));
    return "complete";
  });
}

describe("a chat turn's trace", () => {
  it("nests retrieval and the AI SDK's model call under the turn, with the GenAI attributes", async () => {
    await brightwellTurn();
    const [turn] = named("chat_turn");
    const [retrieval] = named("retrieval chunks");
    const model = t.spans().find((s) => s.attributes["gen_ai.operation.name"] === "chat")!;
    expect(retrieval.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
    expect(retrieval.attributes).toMatchObject({
      "gen_ai.operation.name": "retrieval",
      "gen_ai.data_source.id": "chunks",
      "agentic_chat.retrieval.returned": 8,
      "agentic_chat.retrieval.audit_id": "audit-1",
    });
    // The model call's span is the AI SDK's own, a descendant of the turn.
    expect(model.spanContext().traceId).toBe(turn.spanContext().traceId);
    expect(model.attributes).toMatchObject({
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-6-luna",
      "gen_ai.usage.input_tokens": 1776,
      "gen_ai.usage.output_tokens": 79,
    });
  });

  it("leaves prompts and replies off the spans unless content capture is on", async () => {
    await brightwellTurn();
    const recorded = t.spans().flatMap((s) => Object.keys(s.attributes));
    expect(recorded.filter((k) => /input\.messages|output\.messages|system_instructions/.test(k))).toEqual([]);
    expect(JSON.stringify(t.spans().map((s) => s.attributes))).not.toContain("16 November");
  });

  it("puts the turn's cost on its span, priced from the reported usage and the one price table", async () => {
    await brightwellTurn();
    const [turn] = named("chat_turn");
    // 1,776 input tokens (none from the cache), 79 output: $0.0002171.
    const expected = costOf("gpt-6-luna", { inputTokens: 1776, cachedInputTokens: 0, outputTokens: 79 }).usd;
    expect(expected).toBeCloseTo(0.0002171, 7);
    expect(turn.attributes).toMatchObject({
      "agentic_chat.request.cost_usd": expected,
      "agentic_chat.request.model_calls": 1,
      "agentic_chat.status": "ok",
    });
  });
});

describe("tool and agent spans", () => {
  const tool: AgentTool<{ q: string }, string> = {
    name: "search_documents",
    description: "search",
    input: z.object({ q: z.string() }),
    effect: "read",
    needsApproval: () => false,
    execute: async ({ q }) => {
      if (q === "boom") throw new Error("search_documents timed out after 30 s.");
      return `found ${q}`;
    },
  };
  const ctx = { viewer, runId: "run-1", callId: "call-1", idempotencyKey: "k", signal: new AbortController().signal };

  it("gives each call an execute_tool span under its agent step, and marks a failed call as an error", async () => {
    const traced = tracedTool(t.tracer, tool);
    await agentStep(t.tracer, "tools", { runId: "run-1", kind: "chat", conversationId: "conv-1" }, async () => {
      expect(await traced.execute({ q: "terms" }, ctx)).toBe("found terms");
      await expect(traced.execute({ q: "boom" }, { ...ctx, callId: "call-2" })).rejects.toThrow(/timed out/);
    });
    const [step] = named("invoke_agent kestrel-assistant");
    expect(step.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.id": "run-1",
      "gen_ai.conversation.id": "conv-1",
      "agentic_chat.run.step": "tools",
    });
    const calls = named("execute_tool search_documents");
    expect(calls.map((s) => [s.attributes["gen_ai.tool.call.id"], s.status.code])).toEqual([
      ["call-1", SpanStatusCode.UNSET],
      ["call-2", SpanStatusCode.ERROR],
    ]);
    expect(calls.every((s) => s.parentSpanContext?.spanId === step.spanContext().spanId)).toBe(true);
    expect(calls[0].attributes).toMatchObject({ "gen_ai.tool.type": "function", "agentic_chat.tool.effect": "read" });
  });

  it("keeps the tool's name, schema and approval rule", () => {
    const traced = tracedTool(t.tracer, tool);
    expect([traced.name, traced.input, traced.effect, traced.needsApproval]).toEqual([
      tool.name,
      tool.input,
      tool.effect,
      tool.needsApproval,
    ]);
  });
});
