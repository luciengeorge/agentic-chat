import type { z } from "zod";

/** OpenAI's effort levels for gpt-6-luna. There is no default on purpose: every call names one. */
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/** A function call the model made. `input` is the parsed JSON arguments, or the raw text when they don't parse. */
export interface ChatToolCall {
  callId: string;
  name: string;
  input: unknown;
}

/**
 * A turn of the conversation. An assistant turn may end in tool calls; each call's result comes back as a `tool`
 * message with the same `callId` (an error as `isError` with the message as `output`).
 */
/** A plain text turn, as the RAG answer's history holds them. */
export interface TextMessage {
  role: "user" | "assistant";
  content: string;
}

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ChatToolCall[] }
  | { role: "tool"; callId: string; toolName: string; output: unknown; isError?: boolean };

/** A tool the model may call: its name, what it's for, and its input as a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** "auto" lets the model choose; "required" makes it call some tool; `{ tool }` makes it call that one. */
export type ToolChoice = "auto" | "none" | "required" | { tool: string };

export interface ChatRequest {
  /** The system (developer) instructions. */
  instructions: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
  reasoningEffort: ReasoningEffort;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

export interface Usage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  reasoningTokens: number | undefined;
}

/** "stop" is a finished answer; "length" ran out of output tokens; "other" covers content filters and the rest. */
export type FinishReason = "stop" | "length" | "tool-calls" | "other";

/** A tool call arrives whole: its argument deltas stay inside the client. */
export type ChatEvent =
  | { type: "text-delta"; delta: string }
  | ({ type: "tool-call" } & ChatToolCall)
  | { type: "finish"; finishReason: FinishReason; usage: Usage };

/**
 * The one model interface the app uses. A failed call throws from the iterator; an aborted one throws the
 * signal's reason. Two implementations: the hand-written Responses client (`responses.ts`) and the AI SDK
 * (`ai-sdk.ts`).
 */
export interface ChatModel {
  readonly id: string;
  stream(request: ChatRequest): AsyncIterable<ChatEvent>;
}

/**
 * A request for one JSON object instead of prose (structured output). The provider constrains the model to the
 * schema; the result is still checked against it, since a refusal or a cut-off reply can't match.
 */
export interface ObjectRequest {
  instructions: string;
  messages: ChatMessage[];
  /** The schema's name, sent to the provider: letters, digits, `_` and `-`. */
  name: string;
  reasoningEffort: ReasoningEffort;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

export interface ObjectResult<T> {
  object: T;
  usage: Usage;
}

/**
 * A model that can answer with an object matching a zod schema. Both implementations of `ChatModel` are one too.
 * OpenAI's strict mode needs every field required: write an optional one as `.nullable()`.
 */
export interface StructuredModel {
  readonly id: string;
  object<T>(request: ObjectRequest, schema: z.ZodType<T>): Promise<ObjectResult<T>>;
}
