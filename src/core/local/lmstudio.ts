import type { FetchFunction } from "@ai-sdk/provider-utils";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import type { LocalConfig } from "#learn/local/config";
import type { ChatModel, StructuredModel } from "#learn/model/types";

import { aiSdkChatModel } from "#learn/model/ai-sdk";

/**
 * LM Studio speaks OpenAI's Chat Completions API on `:1234`, so the AI SDK's OpenAI-compatible provider reaches it.
 * No API key: LM Studio doesn't ask for one. `includeUsage` asks for token counts on a stream; structured output
 * goes out as `response_format: json_schema`, which LM Studio enforces with a grammar. The SDK maps the portable
 * `reasoning` option to `reasoning_effort`, which gpt-oss reads (low, medium or high).
 */
export function lmStudio(config: Pick<LocalConfig, "baseURL">, options: { fetch?: FetchFunction } = {}) {
  return createOpenAICompatible({
    name: "lmstudio",
    baseURL: config.baseURL,
    includeUsage: true,
    supportsStructuredOutputs: true,
    fetch: options.fetch,
  });
}

/** The local chat model behind the app's one model interface, so the chat, the rewriter and the agents take it
 * unchanged. */
export function localChatModel(
  config: Pick<LocalConfig, "baseURL" | "chatModel">,
  options: { fetch?: FetchFunction } = {},
): ChatModel & StructuredModel {
  return aiSdkChatModel(lmStudio(config, options).chatModel(config.chatModel));
}
