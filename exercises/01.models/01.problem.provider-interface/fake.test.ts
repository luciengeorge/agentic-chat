// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ChatEvent, ChatModel, ChatRequest } from "#learn/model/types";

import { answer } from "#learn/generate/answer";
import { ABSTAIN_TEXT, buildPrompt } from "#learn/generate/prompt";
import { echoAnswer, echoModel } from "#learn/model/fake";
import { responsesChatModel } from "#learn/model/responses";
import { readUsage } from "#learn/model/tokens";
import { CASSETTE_QUESTION, CASSETTE_SOURCES, cassetteFetch } from "@/core/model/cassette";

/** The prompt of the recorded call: the chat instructions, then both versions of the expenses policy and the question. */
const prompt = buildPrompt({ question: CASSETTE_QUESTION, chunks: CASSETTE_SOURCES });
const request = (extra: Partial<ChatRequest> = {}): ChatRequest => ({
  instructions: prompt.instructions,
  messages: prompt.messages,
  reasoningEffort: "medium",
  ...extra,
});

async function events(model: ChatModel, req: ChatRequest): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of model.stream(req)) out.push(event);
  return out;
}

const text = (list: ChatEvent[]) => list.flatMap((e) => (e.type === "text-delta" ? [e.delta] : [])).join("");
const finishes = (list: ChatEvent[]) => list.filter((e) => e.type === "finish");

describe("the echo model", () => {
  it("streams the answer a word at a time, then ends with one finish", async () => {
    const got = await events(echoModel({ delayMs: 0 }), request());
    const deltas = got.filter((e) => e.type === "text-delta");
    expect(text(got), "the deltas, joined, are echoAnswer(prompt)").toBe(echoAnswer(prompt.messages[0].content));
    expect(deltas.length, "one delta holding the whole answer isn't a stream: one per word").toBeGreaterThan(20);
    expect(finishes(got), "exactly one finish event").toHaveLength(1);
    expect(got.at(-1), "the finish comes last, after every delta").toMatchObject({
      type: "finish",
      finishReason: "stop",
    });
  });

  it("says nothing was billed: usage is undefined, not 0", async () => {
    const got = await events(echoModel({ delayMs: 0 }), request());
    const finish = got.at(-1);
    expect(finish?.type).toBe("finish");
    if (finish?.type !== "finish") return;
    expect(finish.usage, "0 would mean 'counted, and free'; undefined means nobody counted").toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      reasoningTokens: undefined,
    });
    expect(readUsage(finish.usage).reported).toBe(false);
  });

  it("stops when the caller aborts: it throws the signal's reason, and sends no finish", async () => {
    const controller = new AbortController();
    const reason = new Error("Ana closed the tab");
    const seen: ChatEvent[] = [];
    const run = (async () => {
      for await (const event of echoModel({ delayMs: 1 }).stream(request({ abortSignal: controller.signal }))) {
        seen.push(event);
        if (seen.length === 3) controller.abort(reason);
      }
    })();
    const outcome = await run.then(
      () => "returned",
      (error: unknown) => error,
    );
    expect(
      outcome,
      seen.length < 3
        ? "the stream ended before its third delta, so nothing aborted it: stream one word per delta"
        : outcome === "returned"
          ? "the stream ended normally after the abort: pass request.abortSignal to delay(), and let it throw"
          : "it threw, but not the signal's reason",
    ).toBe(reason);
    expect(seen, "nothing more after the abort, and no finish").toHaveLength(3);
  });

  it("streams the abstention, word by word, when the prompt has no sources", async () => {
    const got = await events(
      echoModel({ delayMs: 0 }),
      request({ messages: [{ role: "user", content: "<question>\nWho is Ana?\n</question>" }] }),
    );
    expect(text(got)).toBe(ABSTAIN_TEXT);
    expect(got.filter((e) => e.type === "text-delta").length).toBeGreaterThan(1);
    expect(got.at(-1)?.type).toBe("finish");
  });

  it("runs the app's answer pipeline unchanged, and its citations check out", async () => {
    const out = [];
    for await (const event of answer({
      question: CASSETTE_QUESTION,
      retrieval: { query: CASSETTE_QUESTION, rewritten: [], chunks: CASSETTE_SOURCES, auditId: "a" },
      model: echoModel({ delayMs: 0 }),
      reasoningEffort: "medium",
    })) {
      out.push(event);
    }
    const done = out.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type !== "done") return;
    expect(done.result.finishReason).toBe("stop");
    expect(done.result.report.citations.map((c) => c.label)).toEqual(["S1", "S2"]);
    expect(done.result.flagged).toBe(false);
  });

  it("streams the same shape as the recorded gpt-6-luna call: deltas, then one finish", async () => {
    const recorded = responsesChatModel({
      model: "gpt-6-luna",
      apiKey: "sk-replay",
      fetch: cassetteFetch(["answer"]).fetch,
    });
    const real = await events(recorded, request());
    const echo = await events(echoModel({ delayMs: 0 }), request());

    const shape = (deltas: number) => [...Array<string>(deltas).fill("text-delta"), "finish"];
    expect(real.map((e) => e.type)).toEqual(shape(54));
    expect(
      echo.map((e) => e.type),
      "53 words, so 53 deltas, then the finish",
    ).toEqual(shape(53));

    expect(text(real)).toContain("**£200 a night**");
    expect(readUsage((real.at(-1) as Extract<ChatEvent, { type: "finish" }>).usage)).toEqual({
      input: 598,
      output: 113,
      reasoning: 53,
      total: 711,
      reported: true,
    });
    expect(readUsage((echo.at(-1) as Extract<ChatEvent, { type: "finish" }>).usage).reported).toBe(false);
  });
});
