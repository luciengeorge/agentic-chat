// 👨‍💼 Before Kestrel searches, it asks gpt-6-luna to rewrite the question into a few search queries:
//    "How much can I spend on a hotel in London?" becomes "London hotel accommodation spending limit per
//    night" and two more. Search needs a list it can loop over, not a paragraph, so the model has to answer
//    with a JSON object of a known shape. And before any call, the app should know what it's about to cost.

import {
  jsonSchema,
  type ModelMessage,
  streamText,
  type FinishReason as SdkFinishReason,
  type JSONValue,
  type LanguageModel,
  type ToolSet,
} from "ai";

import type { ChatMessage, ChatModel, FinishReason, StructuredModel, ToolChoice, ToolSpec } from "#learn/model/types";

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

/**
 * The AI SDK behind our interface: `streamText` does the request, retries and stream parsing; `generateText` with
 * `Output.object` does structured output, and checks the reply against the zod schema.
 */
export function aiSdkChatModel(model: LanguageModel): ChatModel & StructuredModel {
  return {
    id: typeof model === "string" ? model : `${model.provider}:${model.modelId}`,

    async object(request, schema) {
      // 🐨 Ask the SDK for one object instead of prose: `generateText` with the model, the instructions, the
      //    messages (through toModelMessages, as stream() does), the request's reasoning effort, its output
      //    limit and abort signal, and an `output` that says "an object matching `schema`, named
      //    request.name".
      // 🐨 Return `{ object, usage }`: the object the SDK parsed and checked, and the usage it reports for
      //    the whole call, as our three counts. Reasoning tokens are a detail of the output tokens.
      //
      // 💰 `import { generateText, Output } from "ai"`. `output: Output.object({ schema, name })`, then
      //    `result.output` is the object. `result.totalUsage.inputTokens`, `.outputTokens`, and
      //    `.outputTokenDetails?.reasoningTokens`. The SDK's option for effort is `reasoning`.
      //
      // 🦉 What "structured output" does on the wire. The SDK turns your zod schema into JSON Schema and
      //    sends it as `text.format`: `{ type: "json_schema", strict: true, name, schema }`. Strict mode makes
      //    OpenAI constrain the model as it writes, token by token, so it can only produce text that fits the
      //    schema. That's why every field must be listed as required: write an optional one as `.nullable()`.
      // 🦉 Why it's still checked. A model can refuse, or run out of output tokens halfway through the
      //    object. Then the text doesn't parse, or doesn't match, and the SDK throws instead of handing you
      //    half an object. JSON.parse on `result.text` would hand it to you.
      // 🦉 Why the name matters. It goes to the model with the schema; "search_queries" tells it what the
      //    object is for. Without one, the SDK sends "response".
      // 🦉 What the SDK does that you did by hand. stream() below sends the request, reads the server-sent
      //    events (step 2's job), assembles tool calls from their deltas (step 3's) and retries a 429. The
      //    hand-written version of object() is createObject in src/core/model/responses.ts.
      //
      // 📜 https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data
      // 📜 https://platform.openai.com/docs/guides/structured-outputs
      //
      // 🚨 The tests check that the request carries a strict json_schema named after the request, with the
      //    effort and the instructions; that the rewriter gets its three recorded queries and the usage
      //    (183 in, 35 out, 0 reasoning); and that a reply that doesn't match the schema throws.
      throw new Error(`object(${request.name}, ${schema.description ?? "a schema"}) isn't written yet`);
    },

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
