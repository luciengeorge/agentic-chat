import { describe, expect, it } from "vitest";

import type { ChatRequest } from "./types";

import {
  countMessageTokens,
  countRequestTokens,
  countTokens,
  countToolTokens,
  MESSAGE_OVERHEAD_TOKENS,
  readUsage,
} from "./tokens";

describe("countTokens", () => {
  it("counts o200k_base tokens, and a special token as plain text", () => {
    expect(countTokens("hello world")).toBe(2);
    expect(countTokens("KPC-2026-0142")).toBeGreaterThan(3);
    expect(countTokens("<|endoftext|>")).toBeGreaterThan(1);
  });
});

describe("countRequestTokens", () => {
  const search = {
    name: "search_documents",
    description: "Search the documents the user can read.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  };
  const request: Pick<ChatRequest, "instructions" | "messages" | "tools"> = {
    instructions: "Answer from the sources.",
    messages: [
      { role: "user", content: "What is the hotel limit in London?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ callId: "c1", name: "search_documents", input: { query: "hotel" } }],
      },
      { role: "tool", callId: "c1", toolName: "search_documents", output: { hits: 2 } },
    ],
    tools: [search],
  };

  it("adds up the instructions, each message with its overhead, and the tool schemas", () => {
    const counted = countRequestTokens(request);
    expect(counted.instructions).toBe(countTokens("Answer from the sources."));
    expect(counted.messages).toBe(request.messages.reduce((sum, m) => sum + countMessageTokens(m), 0));
    expect(counted.tools).toBe(countTokens(JSON.stringify(search)));
    expect(counted.total).toBe(counted.instructions + counted.messages + counted.tools);
  });

  it("charges a message for its role and separators, and a tool call for its name and arguments", () => {
    expect(countMessageTokens({ role: "user", content: "hello world" })).toBe(2 + MESSAGE_OVERHEAD_TOKENS);
    const call = { role: "assistant" as const, content: "", toolCalls: [{ callId: "c", name: "f", input: { a: 1 } }] };
    expect(countMessageTokens(call)).toBe(countTokens('f {"a":1}') + MESSAGE_OVERHEAD_TOKENS);
  });

  it("costs nothing for no tools", () => {
    expect(countToolTokens([])).toBe(0);
    expect(countRequestTokens({ instructions: "", messages: [] }).total).toBe(0);
  });
});

describe("readUsage", () => {
  it("reads what the provider billed, reasoning inside output", () => {
    expect(readUsage({ inputTokens: 1200, outputTokens: 300, reasoningTokens: 120 })).toEqual({
      input: 1200,
      output: 300,
      reasoning: 120,
      total: 1500,
      reported: true,
    });
  });

  it("says when no usage came back", () => {
    expect(readUsage({ inputTokens: undefined, outputTokens: undefined, reasoningTokens: undefined })).toMatchObject({
      total: 0,
      reported: false,
    });
  });
});
