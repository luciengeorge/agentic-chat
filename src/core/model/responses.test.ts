// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  buildRequestBody,
  parseSse,
  ResponsesApiError,
  responsesChatModel,
  streamResponses,
  type ResponsesEvent,
} from "./responses";

// Hand-written in the documented wire format (developers.openai.com, Responses streaming events). `ex record`
// will replace them with recorded traffic.
const sse = (events: Array<Record<string, unknown>>) =>
  events.map((e, i) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`).join("");

const usage = { input_tokens: 42, output_tokens: 7, output_tokens_details: { reasoning_tokens: 3 }, total_tokens: 49 };

const TEXT_STREAM = sse([
  { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant" } },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello" },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: ", world" },
  { type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: "Hello, world" },
  { type: "response.completed", response: { id: "resp_1", status: "completed", usage } },
]);

const TOOL_STREAM = sse([
  { type: "response.created", response: { id: "resp_2", status: "in_progress" } },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { id: "fc_1", type: "function_call", call_id: "call_abc", name: "search", arguments: "" },
  },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"query":' },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '"expenses"}' },
  {
    type: "response.function_call_arguments.done",
    item_id: "fc_1",
    output_index: 0,
    arguments: '{"query":"expenses"}',
  },
  { type: "response.completed", response: { id: "resp_2", status: "completed", usage } },
]);

function bytes(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= encoded.length) return controller.close();
      controller.enqueue(encoded.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

function fakeFetch(body: string, init: ResponseInit = { status: 200 }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = async (url: string | URL | Request, request?: RequestInit) => {
    calls.push({ url: String(url), init: request ?? {} });
    return new Response(bytes(body), { headers: { "content-type": "text/event-stream" }, ...init });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("buildRequestBody", () => {
  it("streams, stores nothing, and always names the reasoning effort", () => {
    const body = buildRequestBody({
      model: "gpt-6-luna",
      instructions: "Be brief.",
      input: [{ role: "user", content: "Hi" }],
      reasoningEffort: "medium",
      maxOutputTokens: 500,
    });
    expect(body).toEqual({
      model: "gpt-6-luna",
      instructions: "Be brief.",
      input: [{ role: "user", content: "Hi" }],
      reasoning: { effort: "medium" },
      max_output_tokens: 500,
      stream: true,
      store: false,
    });
  });

  it("sends tools as strict functions, and tool results back as function_call_output items", () => {
    const body = buildRequestBody({
      model: "gpt-6-luna",
      input: [
        { role: "user", content: "Find the policy" },
        { type: "function_call", call_id: "call_abc", name: "search", arguments: '{"query":"expenses"}' },
        { type: "function_call_output", call_id: "call_abc", output: '{"hits":1}' },
      ],
      tools: [
        {
          name: "search",
          description: "Search the documents",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      ],
      reasoningEffort: "low",
    });
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "search",
        description: "Search the documents",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
        strict: true,
      },
    ]);
    expect(body.input[2]).toEqual({ type: "function_call_output", call_id: "call_abc", output: '{"hits":1}' });
  });
});

describe("parseSse", () => {
  it("joins events split across chunks, skips comments, and joins multi-line data", async () => {
    const text = ': keep-alive\n\nevent: a\ndata: {"x":\ndata: 1}\n\r\nevent: b\r\ndata: 2\r\n\r\n';
    expect(await collect(parseSse(bytes(text, 3)))).toEqual([
      { event: "a", data: '{"x":\n1}' },
      { event: "b", data: "2" },
    ]);
  });
});

describe("streamResponses", () => {
  const request = {
    model: "gpt-6-luna",
    input: [{ role: "user" as const, content: "Hi" }],
    reasoningEffort: "medium" as const,
  };

  it("posts to /v1/responses with the key and yields text deltas, then the finish with usage", async () => {
    const { fetch, calls } = fakeFetch(TEXT_STREAM);
    const events = await collect(streamResponses(request, { apiKey: "sk-test", fetch }));

    expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer sk-test");
    expect(JSON.parse(String(calls[0].init.body)).reasoning).toEqual({ effort: "medium" });
    expect(events).toEqual<ResponsesEvent[]>([
      { type: "text-delta", delta: "Hello" },
      { type: "text-delta", delta: ", world" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 42, outputTokens: 7, reasoningTokens: 3 },
        responseId: "resp_1",
      },
    ]);
  });

  it("assembles a function call from its item and argument deltas", async () => {
    const { fetch } = fakeFetch(TOOL_STREAM);
    const events = await collect(streamResponses(request, { apiKey: "sk-test", fetch }));
    expect(events.slice(0, -1)).toEqual([
      { type: "tool-call", callId: "call_abc", name: "search", arguments: '{"query":"expenses"}' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls" });
  });

  it("maps an incomplete response on max_output_tokens to a length finish", async () => {
    const { fetch } = fakeFetch(
      sse([
        { type: "response.output_text.delta", item_id: "m", delta: "Partial" },
        {
          type: "response.incomplete",
          response: { id: "r", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage },
        },
      ]),
    );
    const events = await collect(streamResponses(request, { apiKey: "k", fetch }));
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "length" });
  });

  it("throws the API's error for a non-2xx answer, with its status and code", async () => {
    const { fetch } = fakeFetch(
      JSON.stringify({ error: { message: "Rate limit reached", type: "rate_limit", code: "rate_limit_exceeded" } }),
      { status: 429 },
    );
    const error = await collect(streamResponses(request, { apiKey: "k", fetch })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResponsesApiError);
    expect(error).toMatchObject({ status: 429, code: "rate_limit_exceeded", message: "Rate limit reached" });
  });

  it("throws on an error event and on a failed response", async () => {
    for (const events of [
      [{ type: "error", code: "server_error", message: "boom", param: null }],
      [{ type: "response.failed", response: { id: "r", status: "failed", error: { code: "x", message: "boom" } } }],
    ]) {
      const { fetch } = fakeFetch(sse(events));
      await expect(collect(streamResponses(request, { apiKey: "k", fetch }))).rejects.toThrow("boom");
    }
  });

  it("throws when the stream ends without a terminal event", async () => {
    const { fetch } = fakeFetch(sse([{ type: "response.output_text.delta", item_id: "m", delta: "Hi" }]));
    await expect(collect(streamResponses(request, { apiKey: "k", fetch }))).rejects.toThrow(/ended before/);
  });

  it("passes the abort signal to fetch", async () => {
    const { fetch, calls } = fakeFetch(TEXT_STREAM);
    const controller = new AbortController();
    await collect(streamResponses(request, { apiKey: "k", fetch, signal: controller.signal }));
    expect(calls[0].init.signal).toBe(controller.signal);
  });
});

describe("responsesChatModel", () => {
  it("is a ChatModel: instructions, messages and effort in; text deltas and the finish out", async () => {
    const { fetch, calls } = fakeFetch(TEXT_STREAM);
    const model = responsesChatModel({ model: "gpt-6-luna", apiKey: "k", fetch });
    const events = await collect(
      model.stream({
        instructions: "Answer from the sources.",
        messages: [
          { role: "user", content: "Q1" },
          { role: "assistant", content: "A1" },
          { role: "user", content: "Q2" },
        ],
        reasoningEffort: "medium",
      }),
    );
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.instructions).toBe("Answer from the sources.");
    expect(body.input).toEqual([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
    ]);
    expect(events.map((e) => e.type)).toEqual(["text-delta", "text-delta", "finish"]);
  });

  it("sends tools and calls back as function_call items with their outputs, and yields parsed calls", async () => {
    const { fetch, calls } = fakeFetch(TOOL_STREAM);
    const model = responsesChatModel({ model: "gpt-6-luna", apiKey: "k", fetch });
    const events = await collect(
      model.stream({
        instructions: "x",
        messages: [
          { role: "user", content: "Find it" },
          { role: "assistant", content: "", toolCalls: [{ callId: "c1", name: "search", input: { query: "a" } }] },
          { role: "tool", callId: "c1", toolName: "search", output: { hits: 1 } },
          { role: "assistant", content: "Again.", toolCalls: [{ callId: "c2", name: "search", input: "{bad" }] },
          { role: "tool", callId: "c2", toolName: "search", output: "invalid input", isError: true },
        ],
        tools: [{ name: "search", description: "Search", inputSchema: { type: "object", properties: {} } }],
        toolChoice: { tool: "search" },
        reasoningEffort: "low",
      }),
    );
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.store).toBe(false);
    expect(body.tool_choice).toEqual({ type: "function", name: "search" });
    expect(body.tools[0]).toMatchObject({ type: "function", name: "search", strict: true });
    expect(body.input).toEqual([
      { role: "user", content: "Find it" },
      { type: "function_call", call_id: "c1", name: "search", arguments: '{"query":"a"}' },
      { type: "function_call_output", call_id: "c1", output: '{"hits":1}' },
      { role: "assistant", content: "Again." },
      { type: "function_call", call_id: "c2", name: "search", arguments: "{bad" },
      { type: "function_call_output", call_id: "c2", output: '{"error":"invalid input"}' },
    ]);
    expect(events).toEqual([
      { type: "tool-call", callId: "call_abc", name: "search", input: { query: "expenses" } },
      expect.objectContaining({ type: "finish", finishReason: "tool-calls" }),
    ]);
  });
});
