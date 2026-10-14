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

export interface ScriptedTurn {
  text?: string;
  /** `input` is sent as JSON, or as given when it's a string (to script arguments that don't parse). */
  toolCalls?: Array<{ callId: string; name: string; input: unknown }>;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * A scripted fake for agent tests: the AI SDK's mock model answers its nth call with the nth turn, text first and
 * then each tool call whole. A call past the script fails the test.
 */
export function scriptedTurns(turns: ScriptedTurn[]): { model: ChatModel; mock: MockLanguageModelV4 } {
  let call = 0;
  const mock = new MockLanguageModelV4({
    modelId: "scripted-turns",
    doStream: async () => {
      const turn = turns[call++];
      if (!turn) throw new Error(`the script has ${turns.length} turns; the model was called again`);
      const calls = turn.toolCalls ?? [];
      return {
        stream: simulateReadableStream({
          chunks: [
            ...(turn.text
              ? [
                  { type: "text-start" as const, id: "t" },
                  { type: "text-delta" as const, id: "t", delta: turn.text },
                  { type: "text-end" as const, id: "t" },
                ]
              : []),
            ...calls.map((c) => ({
              type: "tool-call" as const,
              toolCallId: c.callId,
              toolName: c.name,
              input: typeof c.input === "string" ? c.input : JSON.stringify(c.input),
            })),
            {
              type: "finish" as const,
              finishReason: calls.length
                ? { unified: "tool-calls" as const, raw: "tool_calls" }
                : { unified: "stop" as const, raw: "stop" },
              usage: {
                inputTokens: {
                  total: turn.inputTokens ?? 100,
                  noCache: turn.inputTokens ?? 100,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: turn.outputTokens ?? 10, text: turn.outputTokens ?? 10, reasoning: 0 },
              },
            },
          ],
        }),
      };
    },
  });
  return { model: aiSdkChatModel(mock), mock };
}
