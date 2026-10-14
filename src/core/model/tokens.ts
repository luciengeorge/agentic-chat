/**
 * Token counting in one place (section 01). Before a call, count what you're about to send, to keep it inside a
 * budget; after it, read what the provider says it billed. The two differ a little: the provider adds framing
 * around each message and renders tool schemas its own way, which a local count can only estimate.
 */
import { countTokens as count } from "gpt-tokenizer/encoding/o200k_base";

import type { ChatMessage, ChatRequest, ToolSpec, Usage } from "./types";

const NO_SPECIAL = { disallowedSpecial: new Set<string>() };

/** Tokens in `text` under o200k_base, the encoding of OpenAI's current models. Special tokens count as plain text. */
export function countTokens(text: string): number {
  return count(text, NO_SPECIAL);
}

/** What a message costs besides its content: its role and the separators around it, roughly. */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/** A message's tokens: its text, each tool call's name and arguments, or a tool result's name and output. */
export function countMessageTokens(message: ChatMessage): number {
  if (message.role === "tool") {
    return countTokens(`${message.toolName} ${JSON.stringify(message.output) ?? ""}`) + MESSAGE_OVERHEAD_TOKENS;
  }
  const calls = message.role === "assistant" ? (message.toolCalls ?? []) : [];
  return (
    countTokens(message.content) +
    calls.reduce((sum, c) => sum + countTokens(`${c.name} ${JSON.stringify(c.input) ?? ""}`), 0) +
    MESSAGE_OVERHEAD_TOKENS
  );
}

/** Tool schemas go to the model as JSON: each one's name, description and input schema. */
export function countToolTokens(tools: readonly ToolSpec[]): number {
  return tools.reduce((sum, tool) => sum + countTokens(JSON.stringify(tool)), 0);
}

export interface RequestTokens {
  instructions: number;
  messages: number;
  tools: number;
  total: number;
}

/** The input a request will cost, part by part: the instructions, every message and the tool schemas. */
export function countRequestTokens(request: Pick<ChatRequest, "instructions" | "messages" | "tools">): RequestTokens {
  const instructions = countTokens(request.instructions);
  const messages = request.messages.reduce((sum, message) => sum + countMessageTokens(message), 0);
  const tools = countToolTokens(request.tools ?? []);
  return { instructions, messages, tools, total: instructions + messages + tools };
}

export interface BilledTokens {
  input: number;
  output: number;
  /** Part of `output`: tokens the model spent reasoning, which are billed but never shown. */
  reasoning: number;
  total: number;
  /** False when the provider sent no usage (an aborted stream, a fake model): the numbers are then 0. */
  reported: boolean;
}

/** The usage a call's `finish` event carried, as numbers. */
export function readUsage(usage: Usage): BilledTokens {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return {
    input,
    output,
    reasoning: usage.reasoningTokens ?? 0,
    total: input + output,
    reported: usage.inputTokens !== undefined || usage.outputTokens !== undefined,
  };
}
