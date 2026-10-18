// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "#learn/model/types";

import { countMessageTokens, countRequestTokens, countTokens } from "#learn/model/tokens";
import { CASSETTE_QUESTION, CASSETTE_SOURCES, cassette } from "@/core/model/cassette";

const call = {
  callId: "call_IyXA5wBnbLEOgiPMVwEOKVJR",
  name: "search_documents",
  input: { query: "hotel nightly limit London lodging travel expenses", k: 5 },
};

describe("counting tokens before a call", () => {
  it("counts a text turn as its text plus 4 for the role and separators", () => {
    expect(countTokens(CASSETTE_QUESTION)).toBe(11);
    expect(countMessageTokens({ role: "user", content: CASSETTE_QUESTION })).toBe(15);
    expect(countMessageTokens({ role: "assistant", content: "" })).toBe(4);
  });

  it("counts an assistant's tool call: its name and its arguments, which go back on the wire", () => {
    const counted = countMessageTokens({ role: "assistant", content: "", toolCalls: [call] });
    expect(counted, 'the call is sent again in the next turn: count `search_documents {"query":...}`, plus 4').toBe(
      countTokens(`search_documents ${JSON.stringify(call.input)}`) + 4,
    );
    expect(counted).toBe(21);
    const two = countMessageTokens({ role: "assistant", content: "Searching.", toolCalls: [call, call] });
    expect(two, "text, then every call").toBe(countTokens("Searching.") + 2 * 17 + 4);
  });

  it("counts a tool result: the tool's name and its output as JSON", () => {
    const result: ChatMessage = { role: "tool", callId: call.callId, toolName: call.name, output: { hits: 2 } };
    expect(countMessageTokens(result), 'a result is sent too: `search_documents {"hits":2}`, plus 4').toBe(
      countTokens('search_documents {"hits":2}') + 4,
    );
  });

  it("counts the recorded turn 2 at 714 tokens, where OpenAI billed 721", () => {
    const sent = cassette("tool-call-2").request as {
      instructions: string;
      tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    };
    const passages = CASSETTE_SOURCES.map((c) => ({
      chunkId: c.id,
      documentId: c.documentId,
      title: c.title,
      path: c.path,
      pageStart: c.pageStart,
      pageEnd: c.pageEnd,
      text: c.text,
    }));
    const messages: ChatMessage[] = [
      { role: "user", content: CASSETTE_QUESTION },
      { role: "assistant", content: "", toolCalls: [call] },
      { role: "tool", callId: call.callId, toolName: call.name, output: { passages } },
    ];
    expect(messages.map(countMessageTokens)).toEqual([15, 21, 516]);
    const counted = countRequestTokens({
      instructions: sent.instructions,
      messages,
      tools: sent.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
    });
    expect(counted).toEqual({ instructions: 29, messages: 552, tools: 133, total: 714 });

    const completed = cassette("tool-call-2")
      .body.split("\n")
      .find((line) => line.startsWith('data: {"type":"response.completed"'))!;
    const usage = (JSON.parse(completed.slice("data: ".length)) as { response: { usage: { input_tokens: number } } })
      .response.usage;
    expect(usage.input_tokens).toBe(721);
    expect(usage.input_tokens - counted.total, "OpenAI's framing: a few tokens our count can't see").toBe(7);
  });
});
