// 👨‍💼 When a chat turn is slow, or a tool call fails, the team needs to see every step of that one request: what
//    ran inside what, how long each took, what it cost, and where it broke. This file makes the spans for the work
//    the AI SDK can't see (the turn, retrieval, tools, agent steps), and nests the SDK's own model spans inside
//    them. With telemetry off, the app never calls it.
//
// 🦉 Already written in this file: `GEN_AI` (the convention's attribute names), `tracedRetrieve`, `tracedTools`
//    and `agentStep`, which all build on your `inSpan`. `observeRequest` (`#learn/observability/request`) makes
//    each chat turn's span with it too. You write `inSpan` and `tracedTool`.

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
import { type Attributes, type Span, SpanKind, type Tracer } from "@opentelemetry/api";

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
  // 🐨 Start a span named `name`, with `kind` and `attributes`, and make it the active span while `fn` runs, so any
  //    span started inside (the AI SDK's, a nested tool's) becomes its child. Return what `fn` returns.
  // 🐨 If `fn` throws: record the exception on the span, set its status to error with the error's message, and
  //    throw the error on. A thrown value that isn't an `Error` is wrapped in one for the record.
  // 🐨 However `fn` ends, end the span exactly once. A span that never ends is never sent.
  // 🐨 The classic mistake: `tracer.startSpan`. It makes a span but doesn't make it active, so the spans started
  //    inside get no parent. Ella's model call would land in a trace of its own, and nothing would join it to her
  //    turn.
  //
  // 💰 `tracer.startActiveSpan(name, { kind, attributes }, async (span) => ...)` returns what its callback
  //    returns. `try`, `catch`, `finally`. `SpanStatusCode.ERROR` from `@opentelemetry/api`; add it to the import.
  //
  // 🦉 Why spans and not log lines. A log line is a moment: "retrieval done in 640 ms". A span is an interval with
  //    a parent, so a trace is a tree that shows what ran inside what, and what ran at the same time. Nine seconds
  //    of a turn split into retrieval, a rewrite, a model call and three tool calls is the answer to "where did
  //    the time go", and no pile of log lines gives it without someone stitching them by hand.
  // 🦉 Why the parent comes from the active span. The AI SDK starts its spans deep inside `streamText`, which you
  //    can't change. OpenTelemetry's context (carried through `await`s by Node's AsyncLocalStorage) is how it
  //    finds the span that's running. Make yours active and every library that reports spans nests under it.
  //
  // 🚨 The tests check a child span's parent, the return value, an error span and its rethrow, the span ending,
  //    and Ella's five-span tree.
  throw new Error(
    `inSpan(${typeof tracer}, ${JSON.stringify(name)}, ${Object.keys(attributes).length} attributes, ${typeof fn}, kind ${kind}) isn't written yet`,
  );
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
  // 🐨 Return the same tool with one change: `execute` runs the tool's own `execute` inside `inSpan`, in a span
  //    named `execute_tool <the tool's name>`. Everything else (name, description, schema, effect, approval rule)
  //    stays exactly as it was.
  // 🐨 Its attributes, from `GEN_AI` where the conventions have a name: the operation (`execute_tool`), the tool's
  //    name, the call id from `ctx`, the tool type (`function`), and the app's own `agentic_chat.tool.effect` and
  //    `agentic_chat.run.id`.
  // 🐨 The classic mistake: building a new tool from a few fields. A traced `send_mail` that lost `needsApproval`
  //    would send mail without asking anyone. Spread the tool, then replace `execute`.
  //
  // 🦉 Why no input on the span. A tool's input is what the model asked for: a search query, a mail's body, a
  //    recipient. Spans go to a collector other people read, often another company's. The name, the call id and
  //    the effect say what happened; what it said stays in the run's event log, under the tenant's own access.
  // 🦉 Why a failed call is an error span and still a result. Your `inSpan` marks the span and throws on; the loop
  //    (section 13) still turns the throw into an `ok: false` result for the model. The trace shows the failure,
  //    and the agent behaves as before.
  //
  // 🚨 The tests check the span's name and attributes, its parent, a failed call, and that the tool is unchanged.
  throw new Error(`tracedTool(${typeof tracer}, ${tool.name}) isn't written yet`);
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
