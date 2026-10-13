import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import type { ChatModel } from "./types";

import { aiSdkChatModel } from "./ai-sdk";

/** A scripted fake for tests: the AI SDK's mock model replies with `text`, in pieces of `pieceSize` characters. */
export function scriptedModel(
  text: string,
  { pieceSize = 8, chunkDelayInMs }: { pieceSize?: number; chunkDelayInMs?: number } = {},
): { model: ChatModel; mock: MockLanguageModelV4 } {
  const pieces = text.match(new RegExp(`[\\s\\S]{1,${pieceSize}}`, "g")) ?? [];
  const mock = new MockLanguageModelV4({
    modelId: "scripted",
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "t" },
          ...pieces.map((delta) => ({ type: "text-delta" as const, id: "t", delta })),
          { type: "text-end" as const, id: "t" },
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage: {
              inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: pieces.length, text: pieces.length, reasoning: 0 },
            },
          },
        ],
        chunkDelayInMs,
      }),
    }),
  });
  return { model: aiSdkChatModel(mock), mock };
}

/** The text of the prompt the mock model received, every message joined. */
export function promptText(mock: MockLanguageModelV4, call = 0): string {
  return mock.doStreamCalls[call].prompt
    .map((m) =>
      typeof m.content === "string" ? m.content : m.content.map((p) => ("text" in p ? p.text : "")).join(""),
    )
    .join("\n");
}
