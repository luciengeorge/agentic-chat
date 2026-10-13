import { streamText, type FinishReason as SdkFinishReason, type LanguageModel } from "ai";

import type { ChatModel, FinishReason } from "./types";

const finishReason = (reason: SdkFinishReason): FinishReason =>
  reason === "stop" || reason === "length" || reason === "tool-calls" ? reason : "other";

/** The AI SDK behind our interface: `streamText` does the request, retries and stream parsing. */
export function aiSdkChatModel(model: LanguageModel): ChatModel {
  return {
    id: typeof model === "string" ? model : `${model.provider}:${model.modelId}`,
    async *stream(request) {
      const result = streamText({
        model,
        instructions: request.instructions,
        messages: request.messages,
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
