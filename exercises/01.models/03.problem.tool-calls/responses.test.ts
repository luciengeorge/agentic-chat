// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ChatEvent, ChatMessage, ToolSpec } from "#learn/model/types";

import { responsesChatModel, toInputItems } from "#learn/model/responses";
import { CASSETTE_QUESTION, CASSETTE_SOURCES, cassette, cassetteFetch } from "@/core/model/cassette";

const call = { callId: "call_1", name: "search_documents", input: { query: "hotel limit London", k: null } };

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("the tool-call wire format", () => {
  it("sends user and assistant text turns as role items, in order", () => {
    expect(
      toInputItems([
        { role: "user", content: "Q1" },
        { role: "assistant", content: "A1" },
        { role: "user", content: "Q2" },
      ]),
    ).toEqual([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
    ]);
  });

  it("sends a call as a function_call item, with its arguments as a string of JSON", () => {
    const items = toInputItems([{ role: "assistant", content: "Let me look.", toolCalls: [call] }]);
    expect(
      items,
      "the text, then each call as a function_call item: with store: false, OpenAI has forgotten it",
    ).toEqual([
      { role: "assistant", content: "Let me look." },
      {
        type: "function_call",
        call_id: "call_1",
        name: "search_documents",
        arguments: '{"query":"hotel limit London","k":null}',
      },
    ]);
  });

  it("leaves out the assistant's text when it made calls and wrote nothing", () => {
    const items = toInputItems([{ role: "assistant", content: "", toolCalls: [call, { ...call, callId: "call_2" }] }]);
    expect(
      items.map((item) => ("type" in item ? `${item.type} ${item.call_id}` : `text ${item.role}`)),
      "an empty assistant item beside the calls says nothing; leave it out",
    ).toEqual(["function_call call_1", "function_call call_2"]);
  });

  it("sends arguments that didn't parse exactly as the model wrote them", () => {
    const [item] = toInputItems([
      { role: "assistant", content: "", toolCalls: [{ ...call, input: '{"query": "hot' }] },
    ]);
    expect(item, "a string input is the model's own text: JSON.stringify would quote it a second time").toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "search_documents",
      arguments: '{"query": "hot',
    });
  });

  it("sends a result as function_call_output with the same call_id, its output as a string, an error as {error}", () => {
    const items = toInputItems([
      { role: "tool", callId: "call_1", toolName: "search_documents", output: { passages: [] } },
      { role: "tool", callId: "call_2", toolName: "search_documents", output: "k must be 8 or less", isError: true },
    ]);
    expect(items, "an output is a string: JSON.stringify it, and an error as {error: message}").toEqual([
      { type: "function_call_output", call_id: "call_1", output: '{"passages":[]}' },
      { type: "function_call_output", call_id: "call_2", output: '{"error":"k must be 8 or less"}' },
    ]);
  });

  it("replays the recorded exchange: call_IyXA5wBnbLEOgiPMVwEOKVJR's search, then turn 2 exactly as it was sent", async () => {
    const first = cassette("tool-call-1").request as {
      instructions: string;
      tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    };
    const tools: ToolSpec[] = first.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
    }));
    const { fetch, requests } = cassetteFetch(["tool-call-1", "tool-call-2"]);
    const model = responsesChatModel({ model: "gpt-6-luna", apiKey: "sk-replay", fetch });
    const ask = (messages: ChatMessage[]) =>
      collect(
        model.stream({
          instructions: first.instructions,
          messages,
          tools,
          toolChoice: "auto",
          reasoningEffort: "medium",
          maxOutputTokens: 2000,
        }),
      );

    // Turn 1: the question. The model answers with a call, not text.
    const question: ChatMessage = { role: "user", content: CASSETTE_QUESTION };
    const turn1: ChatEvent[] = await ask([question]);
    expect(turn1).toEqual([
      {
        type: "tool-call",
        callId: "call_IyXA5wBnbLEOgiPMVwEOKVJR",
        name: "search_documents",
        input: { query: "hotel nightly limit London lodging travel expenses", k: 5 },
      },
      { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 172, outputTokens: 28, reasoningTokens: 0 } },
    ]);

    // Turn 2: the question again, the call, and the search's two passages, as the agent loop sends them.
    const made = turn1[0] as Extract<ChatEvent, { type: "tool-call" }>;
    const passages = CASSETTE_SOURCES.map((c) => ({
      chunkId: c.id,
      documentId: c.documentId,
      title: c.title,
      path: c.path,
      pageStart: c.pageStart,
      pageEnd: c.pageEnd,
      text: c.text,
    }));
    const turn2 = await ask([
      question,
      { role: "assistant", content: "", toolCalls: [{ callId: made.callId, name: made.name, input: made.input }] },
      { role: "tool", callId: made.callId, toolName: made.name, output: { passages } },
    ]);

    const sent = requests[1].body;
    const recorded = cassette("tool-call-2").request;
    expect(sent.input, "turn 2's input items must match what OpenAI accepted on 18 October").toEqual(recorded.input);
    expect(sent).toEqual(recorded);
    expect(turn2.flatMap((e) => (e.type === "text-delta" ? [e.delta] : [])).join("")).toBe(
      "The hotel limit in London is **£200 per night**.",
    );
    expect(turn2.at(-1)).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 721, outputTokens: 17, reasoningTokens: 0 },
    });
  });
});
