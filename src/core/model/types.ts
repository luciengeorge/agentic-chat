/** OpenAI's effort levels for gpt-6-luna. There is no default on purpose: every call names one. */
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  /** The system (developer) instructions. */
  instructions: string;
  messages: ChatMessage[];
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

export type ChatEvent =
  | { type: "text-delta"; delta: string }
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
