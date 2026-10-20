// @vitest-environment node
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { AgentTool } from "#learn/agent/types";
import type { Retrieve } from "#learn/retrieve/types";

import { answer } from "#learn/generate/answer";
import { APP_K, recordedTurn, replayModel } from "#learn/generate/recorded";
import { observeRequest } from "#learn/observability/request";
import { agentStep, inSpan, tracedRetrieve, tracedTool } from "#learn/observability/spans";
import { testTelemetry } from "#learn/observability/testing";

const t = testTelemetry();
const viewer = { tenantId: "t1", userId: "u1" };

beforeAll(() => t.install());
afterAll(() => t.uninstall());
beforeEach(() => t.resetSpans());

const named = (name: string) => t.spans().filter((s) => s.name === name);
const id = (s: ReturnType<typeof t.spans>[number]) => s.spanContext().spanId;
const parentOf = (s: ReturnType<typeof t.spans>[number]) => s.parentSpanContext?.spanId;

describe("inSpan", () => {
  it("makes its span the active one, so a span started inside becomes its child", async () => {
    await inSpan(t.tracer, "outer", {}, async () => {
      await inSpan(t.tracer, "inner", {}, async () => {});
      t.tracer.startSpan("started by a library").end();
    });
    const [outer] = named("outer");
    expect(outer, "the outer span must end, so it's exported").toBeDefined();
    expect(parentOf(named("inner")[0]), "start the span with startActiveSpan, so it's active while fn runs").toBe(
      id(outer),
    );
    expect(parentOf(named("started by a library")[0]), "any span started while yours is active is its child").toBe(
      id(outer),
    );
    expect(parentOf(outer)).toBeUndefined();
  });

  it("returns what the function returns, with the span's name, kind and attributes", async () => {
    const result = await inSpan(
      t.tracer,
      "work",
      { "a.b": 1 },
      async (span) => span.spanContext().spanId,
      SpanKind.SERVER,
    );
    const [span] = named("work");
    expect(result).toBe(id(span));
    expect(span.kind).toBe(SpanKind.SERVER);
    expect(span.attributes).toEqual({ "a.b": 1 });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("marks a span whose work threw as an error, records the exception, ends it and throws on", async () => {
    await expect(
      inSpan(t.tracer, "boom", {}, async () => {
        throw new Error("search_documents timed out after 30 s.");
      }),
      "the caller still needs the error: rethrow it",
    ).rejects.toThrow("timed out");
    const spans = named("boom");
    expect(spans, "a failed span must still end (in a finally), once").toHaveLength(1);
    expect(spans[0].status).toEqual({ code: SpanStatusCode.ERROR, message: "search_documents timed out after 30 s." });
    expect(
      spans[0].events.map((e) => e.name),
      "span.recordException(error)",
    ).toEqual(["exception"]);
  });

  it("records a thrown value that isn't an Error, wrapped in one", async () => {
    await expect(
      inSpan(t.tracer, "odd", {}, async () => {
        throw "a string";
      }),
    ).rejects.toBe("a string");
    const [span] = named("odd");
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: "a string" });
    expect(span.events[0]?.attributes?.["exception.message"], "record it as new Error(String(value))").toBe("a string");
  });
});

describe("tracedTool", () => {
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

  it("gives each call an execute_tool span with the convention's attributes, under the agent step", async () => {
    const traced = tracedTool(t.tracer, tool);
    await agentStep(t.tracer, "tools", { runId: "run-1", kind: "chat" }, async () => {
      expect(await traced.execute({ q: "KPC-2026-0142 payment terms" }, ctx)).toBe("found KPC-2026-0142 payment terms");
    });
    const [step] = named("invoke_agent kestrel-assistant");
    const [call] = named("execute_tool search_documents");
    expect(call, 'name the span "execute_tool <tool name>"').toBeDefined();
    expect(parentOf(call)).toBe(id(step));
    expect(call.attributes, "exactly these six: the tool's input stays off the span").toEqual({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "search_documents",
      "gen_ai.tool.call.id": "call-1",
      "gen_ai.tool.type": "function",
      "agentic_chat.tool.effect": "read",
      "agentic_chat.run.id": "run-1",
    });
    expect(JSON.stringify(call.attributes), "the tool's input stays off the span").not.toContain("KPC-2026-0142");
  });

  it("marks a failed call as an error span and throws on, so the loop still sees the failure", async () => {
    const traced = tracedTool(t.tracer, tool);
    await expect(traced.execute({ q: "boom" }, { ...ctx, callId: "call-2" })).rejects.toThrow(/timed out/);
    const [call] = named("execute_tool search_documents");
    expect([call.attributes["gen_ai.tool.call.id"], call.status.code]).toEqual(["call-2", SpanStatusCode.ERROR]);
  });

  it("keeps the tool's name, description, schema, effect and approval rule", () => {
    const traced = tracedTool(t.tracer, tool);
    expect(
      [traced.name, traced.description, traced.input, traced.effect, traced.needsApproval],
      "spread the tool and replace execute: a send_mail that lost needsApproval would send without asking",
    ).toEqual([tool.name, tool.description, tool.input, tool.effect, tool.needsApproval]);
    expect(traced.execute).not.toBe(tool.execute);
  });
});

describe("Ella Brooks's Brightwell turn, as a trace", () => {
  it("is five spans in one tree: the turn, retrieval, and the AI SDK's three inside it", async () => {
    const turn = recordedTurn("brightwell");
    expect(turn.user).toBe("ella.brooks");
    const retrieve: Retrieve = async (_viewer, query) => ({
      query,
      rewritten: turn.rewritten,
      chunks: turn.chunks.slice(0, APP_K),
      auditId: "audit-1",
    });
    await observeRequest(t, { route: "chat_turn" }, async () => {
      const retrieval = await tracedRetrieve(t.tracer, retrieve)(viewer, turn.question);
      for await (const _ of answer({
        question: turn.question,
        retrieval,
        model: replayModel("brightwell").model,
        reasoningEffort: "medium",
      }));
      return "complete";
    });

    const spans = t.spans();
    const byId = new Map(spans.map((s) => [id(s), s]));
    const tree = spans
      .map((s) => {
        const path = [s.name];
        for (let p = parentOf(s); p && byId.has(p); p = parentOf(byId.get(p)!)) path.unshift(byId.get(p)!.name);
        return path.join(" > ");
      })
      .sort();
    expect(tree, "every span hangs from chat_turn: each inSpan must be active while its work runs").toEqual([
      "chat_turn",
      "chat_turn > invoke_agent gpt-6-luna",
      "chat_turn > invoke_agent gpt-6-luna > step 1",
      "chat_turn > invoke_agent gpt-6-luna > step 1 > chat gpt-6-luna",
      "chat_turn > retrieval chunks",
    ]);
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size, "one trace").toBe(1);

    const [turnSpan] = named("chat_turn");
    expect(turnSpan.attributes).toMatchObject({
      "agentic_chat.status": "ok",
      "agentic_chat.request.model_calls": 1,
      "gen_ai.usage.input_tokens": 1776,
      "gen_ai.usage.output_tokens": 79,
    });
    expect(turnSpan.attributes["agentic_chat.request.cost_usd"]).toBeCloseTo(0.0002171, 10);
    expect(named("retrieval chunks")[0].attributes).toMatchObject({
      "agentic_chat.retrieval.returned": 8,
      "agentic_chat.retrieval.rewrites": 3,
    });
    expect(named("chat gpt-6-luna")[0].attributes).toMatchObject({
      "gen_ai.request.model": "gpt-6-luna",
      "gen_ai.usage.input_tokens": 1776,
      "gen_ai.usage.output_tokens": 79,
    });
    expect(JSON.stringify(spans.map((s) => s.attributes)), "no prompt or reply on any span").not.toContain(
      "16 November",
    );
  });
});
