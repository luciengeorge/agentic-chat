// @vitest-environment node
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import type { ChatEvent } from "./types";

import { aiSdkChatModel } from "./ai-sdk";

const finish = {
  type: "finish" as const,
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 3, reasoning: 2 },
  },
};

function scripted(deltas: string[]) {
  return new MockLanguageModelV4({
    modelId: "gpt-6-luna",
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "t" },
          ...deltas.map((delta) => ({ type: "text-delta" as const, id: "t", delta })),
          { type: "text-end" as const, id: "t" },
          finish,
        ],
      }),
    }),
  });
}

async function collect(iterable: AsyncIterable<ChatEvent>) {
  const out: ChatEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describe("aiSdkChatModel", () => {
  it("streams text deltas, then the finish with usage", async () => {
    const model = aiSdkChatModel(scripted(["Hel", "lo"]));
    const events = await collect(
      model.stream({ instructions: "x", messages: [{ role: "user", content: "Hi" }], reasoningEffort: "medium" }),
    );
    expect(events).toEqual([
      { type: "text-delta", delta: "Hel" },
      { type: "text-delta", delta: "lo" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 2 } },
    ]);
  });

  it("sends the instructions as the system prompt, the history in order, and the reasoning effort", async () => {
    const mock = scripted(["ok"]);
    await collect(
      aiSdkChatModel(mock).stream({
        instructions: "Answer from the sources.",
        messages: [
          { role: "user", content: "Q1" },
          { role: "assistant", content: "A1" },
          { role: "user", content: "Q2" },
        ],
        reasoningEffort: "medium",
        maxOutputTokens: 300,
      }),
    );
    const call = mock.doStreamCalls[0];
    expect(call.reasoning).toBe("medium");
    expect(call.maxOutputTokens).toBe(300);
    expect(call.prompt.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(call.prompt[0]).toMatchObject({ role: "system", content: "Answer from the sources." });
  });

  it("throws the model's error", async () => {
    const mock = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("upstream down");
      },
    });
    await expect(
      collect(
        aiSdkChatModel(mock).stream({
          instructions: "x",
          messages: [{ role: "user", content: "Hi" }],
          reasoningEffort: "low",
        }),
      ),
    ).rejects.toThrow("upstream down");
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    const mock = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start" as const, id: "t" },
            ...Array.from({ length: 50 }, () => ({ type: "text-delta" as const, id: "t", delta: "x" })),
            { type: "text-end" as const, id: "t" },
            finish,
          ],
          chunkDelayInMs: 5,
        }),
      }),
    });
    const seen: ChatEvent[] = [];
    const run = (async () => {
      for await (const event of aiSdkChatModel(mock).stream({
        instructions: "x",
        messages: [{ role: "user", content: "Hi" }],
        reasoningEffort: "low",
        abortSignal: controller.signal,
      })) {
        seen.push(event);
        if (seen.length === 3) controller.abort(new Error("client went away"));
      }
    })();
    await expect(run).rejects.toThrow();
    expect(seen.length).toBeLessThan(10);
    expect(seen.some((e) => e.type === "finish")).toBe(false);
  });
});
