/**
 * Spans for the work the AI SDK can't see: retrieval, tool calls and agent turns. The AI SDK makes its own spans
 * for every model call once its OpenTelemetry integration is registered (`#learn/observability/setup`); these wrap
 * around them, so a trace reads top to bottom: the agent turn, the model call inside it, the tool it asked for, the
 * retrieval inside that tool.
 *
 * Names and attributes follow the OpenTelemetry GenAI semantic conventions
 * (https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/): a span is named "{operation} {target}"
 * ("execute_tool search_documents", "retrieval chunks") and says what it is in `gen_ai.operation.name`. What the
 * conventions don't cover gets an `agentic_chat.` prefix.
 *
 * Every wrapper takes the tracer as an argument. With telemetry off the app never calls them, so there is nothing
 * to switch off inside.
 */
import { type Attributes, type Span, SpanKind, SpanStatusCode, type Tracer } from "@opentelemetry/api";

import type { AgentTool } from "#learn/agent/types";
import type { Retrieval, Retrieve, Viewer } from "#learn/retrieve/types";

/** The GenAI convention's attribute names, in one place. */
export const GEN_AI = {
  operation: "gen_ai.operation.name",
  provider: "gen_ai.provider.name",
  requestModel: "gen_ai.request.model",
  conversationId: "gen_ai.conversation.id",
  agentId: "gen_ai.agent.id",
  agentName: "gen_ai.agent.name",
  toolName: "gen_ai.tool.name",
  toolCallId: "gen_ai.tool.call.id",
  toolType: "gen_ai.tool.type",
  dataSourceId: "gen_ai.data_source.id",
  retrievalQuery: "gen_ai.retrieval.query.text",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  cacheReadTokens: "gen_ai.usage.cache_read.input_tokens",
  tokenType: "gen_ai.token.type",
} as const;

/** The agent's name in its spans. */
export const AGENT_NAME = "kestrel-assistant";

/**
 * Runs `fn` inside a new span that is the current one while it runs, so spans started inside (the AI SDK's, a
 * nested tool's) become its children. A throw marks the span as an error and is rethrown; the span always ends.
 */
export async function inSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  return tracer.startActiveSpan(name, { kind, attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

export interface RetrieveSpanOptions {
  /** Record the question on the span. Off by default: it's what the user typed. */
  captureQuery?: boolean;
  /** Called with each retrieval's result inside its span, to add what the result alone can't say. */
  onResult?: (retrieval: Retrieval, span: Span, viewer: Viewer) => Promise<void> | void;
}

/** `retrieve`, with a "retrieval chunks" span around each call: how many chunks came back and the audit row. */
export function tracedRetrieve(tracer: Tracer, retrieve: Retrieve, options: RetrieveSpanOptions = {}): Retrieve {
  return (viewer, query, opts) =>
    inSpan(
      tracer,
      "retrieval chunks",
      {
        [GEN_AI.operation]: "retrieval",
        [GEN_AI.dataSourceId]: "chunks",
        ...(opts?.k !== undefined && { "agentic_chat.retrieval.k": opts.k }),
        ...(options.captureQuery && { [GEN_AI.retrievalQuery]: query }),
      },
      async (span) => {
        const retrieval = await retrieve(viewer, query, opts);
        span.setAttributes({
          "agentic_chat.retrieval.returned": retrieval.chunks.length,
          "agentic_chat.retrieval.rewrites": retrieval.rewritten.length,
          "agentic_chat.retrieval.audit_id": retrieval.auditId,
        });
        await options.onResult?.(retrieval, span, viewer);
        return retrieval;
      },
    );
}

/** One tool with an "execute_tool <name>" span around each call. A failed call is an error span; the loop still
 * turns it into an `ok: false` result as before. */
export function tracedTool<I, O>(tracer: Tracer, tool: AgentTool<I, O>): AgentTool<I, O> {
  return {
    ...tool,
    execute: (input, ctx) =>
      inSpan(
        tracer,
        `execute_tool ${tool.name}`,
        {
          [GEN_AI.operation]: "execute_tool",
          [GEN_AI.toolName]: tool.name,
          [GEN_AI.toolCallId]: ctx.callId,
          [GEN_AI.toolType]: "function",
          "agentic_chat.tool.effect": tool.effect,
          "agentic_chat.run.id": ctx.runId,
        },
        () => tool.execute(input, ctx),
      ),
  };
}

export function tracedTools(tracer: Tracer, tools: readonly AgentTool[]): AgentTool[] {
  return tools.map((tool) => tracedTool(tracer, tool));
}

export interface AgentTurnAttributes {
  runId: string;
  /** chat, automation or subagent. */
  kind: string;
  conversationId?: string | null;
}

/**
 * One step of an agent run, "invoke_agent kestrel-assistant": a model turn, or a turn's tool calls. A durable run
 * spans minutes or days and many processes, so it has no single span; its steps share `gen_ai.agent.id`, the run
 * id, and a trace search on it lines them up.
 */
export function agentStep<T>(
  tracer: Tracer,
  step: "model" | "tools",
  run: AgentTurnAttributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return inSpan(
    tracer,
    `invoke_agent ${AGENT_NAME}`,
    {
      [GEN_AI.operation]: "invoke_agent",
      [GEN_AI.agentName]: AGENT_NAME,
      [GEN_AI.agentId]: run.runId,
      "agentic_chat.run.kind": run.kind,
      "agentic_chat.run.step": step,
      ...(run.conversationId && { [GEN_AI.conversationId]: run.conversationId }),
    },
    fn,
  );
}
