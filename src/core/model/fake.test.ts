// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ChatEvent } from "./types";

import { echoAnswer, echoModel } from "./fake";

const prompt = `<sources>\n<source id="S1" title="Policy" path="/p.pdf">\nHotels in London cost up to £200 a night. Book early.\n</source>\n</sources>`;

describe("echoModel", () => {
  it("streams the echo answer word by word, then one finish with no usage", async () => {
    const events: ChatEvent[] = [];
    for await (const event of echoModel({ delayMs: 0 }).stream({
      instructions: "",
      messages: [{ role: "user", content: prompt }],
      reasoningEffort: "medium",
    })) {
      events.push(event);
    }
    const text = events.flatMap((e) => (e.type === "text-delta" ? [e.delta] : [])).join("");
    expect(text).toBe(echoAnswer(prompt));
    expect(events.at(-1)).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: undefined, outputTokens: undefined, reasoningTokens: undefined },
    });
  });

  it("stops with the signal's reason when it aborts between two deltas", async () => {
    const controller = new AbortController();
    const reason = new Error("the user left");
    const seen: ChatEvent[] = [];
    const run = (async () => {
      for await (const event of echoModel({ delayMs: 0 }).stream({
        instructions: "",
        messages: [{ role: "user", content: prompt }],
        reasoningEffort: "medium",
        abortSignal: controller.signal,
      })) {
        seen.push(event);
        if (seen.length === 2) controller.abort(reason);
      }
    })();
    await expect(run).rejects.toBe(reason);
    expect(seen).toHaveLength(2);
  });
});
