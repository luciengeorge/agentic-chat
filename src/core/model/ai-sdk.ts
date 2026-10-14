import {
  jsonSchema,
  type ModelMessage,
  streamText,
  type FinishReason as SdkFinishReason,
  type JSONValue,
  type LanguageModel,
  type ToolSet,
} from "ai";

import type { ChatMessage, ChatModel, FinishReason, ToolChoice, ToolSpec } from "./types";

const finishReason = (reason: SdkFinishReason): FinishReason =>
  reason === "stop" || reason === "length" || reason === "tool-calls" ? reason : "other";

/** Tools with no `execute`: the SDK reports the calls and stops, and the agent loop runs them. */
const toolSet = (tools: ToolSpec[]): ToolSet =>
  Object.fromEntries(
    tools.map((tool) => [tool.name, { description: tool.description, inputSchema: jsonSchema(tool.inputSchema) }]),
  );

const toolChoice = (choice: ToolChoice | undefined) =>
  choice === undefined || typeof choice === "string" ? choice : { type: "tool" as const, toolName: choice.tool };

function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    switch (message.role) {
      case "user":
        return { role: "user", content: message.content };
      case "assistant":
        if (!message.toolCalls?.length) return { role: "assistant", content: message.content };
        return {
          role: "assistant",
          content: [
            ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
            ...message.toolCalls.map((call) => ({
              type: "tool-call" as const,
              toolCallId: call.callId,
              toolName: call.name,
              input: call.input,
            })),
          ],
        };
      case "tool":
        return {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.callId,
              toolName: message.toolName,
              output: message.isError
                ? { type: "error-text", value: String(message.output) }
                : { type: "json", value: (message.output ?? null) as JSONValue },
            },
          ],
        };
    }
  });
}

/** The AI SDK behind our interface: `streamText` does the request, retries and stream parsing. */
export function aiSdkChatModel(model: LanguageModel): ChatModel {
  return {
    id: typeof model === "string" ? model : `${model.provider}:${model.modelId}`,
    async *stream(request) {
      const result = streamText({
        model,
        instructions: request.instructions,
        messages: toModelMessages(request.messages),
        ...(request.tools?.length ? { tools: toolSet(request.tools), toolChoice: toolChoice(request.toolChoice) } : {}),
        reasoning: request.reasoningEffort,
        maxOutputTokens: request.maxOutputTokens,
        abortSignal: request.abortSignal,
        // Errors arrive as stream parts and are rethrown below; this stops the SDK logging them too.
        onError: () => {},
      });
      for await (const part of result.stream) {
        switch (part.type) {
          case "text-delta":
            yield { type: "text-delta", delta: part.text };
            break;
          case "tool-call":
            // An unparsable or unknown call still goes to the loop, which answers it with a validation error.
            yield { type: "tool-call", callId: part.toolCallId, name: part.toolName, input: part.input };
            break;
          case "finish":
            yield {
              type: "finish",
              finishReason: finishReason(part.finishReason),
              usage: {
                inputTokens: part.totalUsage.inputTokens,
                outputTokens: part.totalUsage.outputTokens,
                reasoningTokens: part.totalUsage.outputTokenDetails?.reasoningTokens,
              },
            };
            break;
          case "error":
            throw part.error;
          case "abort":
            throw request.abortSignal?.reason ?? new DOMException("aborted", "AbortError");
        }
      }
    },
  };
}
