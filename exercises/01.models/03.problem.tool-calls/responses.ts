// 👨‍💼 Asked about the London hotel limit, Kestrel's agent doesn't answer straight away. It asks the app to
//    search the documents, the app runs the search, and the passages go back to the model for a second
//    turn. Both directions have a wire format, and if the second request gets it wrong, OpenAI refuses it.

import type { ChatMessage, ChatModel, FinishReason, ReasoningEffort, ToolChoice, Usage } from "#learn/model/types";

/**
 * A hand-written client for OpenAI's Responses API (`POST /v1/responses`), streaming only. It shows the wire
 * format the AI SDK hides: the request body, server-sent events, and how a function call arrives (an output item,
 * then argument deltas) and how its result goes back (a `function_call_output` input item).
 */

export interface ResponsesTool {
  name: string;
  description: string;
  /** A JSON Schema object. Strict mode needs `additionalProperties: false`, which is added when missing. */
  parameters: Record<string, unknown>;
}

export type ResponsesInputItem =
  | { role: "user" | "assistant" | "developer"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: ResponsesInputItem[];
  tools?: ResponsesTool[];
  toolChoice?: ToolChoice;
  reasoningEffort: ReasoningEffort;
  maxOutputTokens?: number;
}

export type ResponsesEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; callId: string; name: string; arguments: string }
  | { type: "finish"; finishReason: FinishReason; usage: Usage; responseId: string | undefined };

export interface ResponsesDeps {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  signal?: AbortSignal;
}

export class ResponsesApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "ResponsesApiError";
  }
}

export function buildRequestBody(request: ResponsesRequest) {
  return {
    model: request.model,
    ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
    input: request.input,
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function" as const,
            name: tool.name,
            description: tool.description,
            parameters: { ...tool.parameters, additionalProperties: tool.parameters.additionalProperties ?? false },
            strict: true,
          })),
          ...(request.toolChoice === undefined
            ? {}
            : {
                tool_choice:
                  typeof request.toolChoice === "string"
                    ? request.toolChoice
                    : { type: "function" as const, name: request.toolChoice.tool },
              }),
        }
      : {}),
    reasoning: { effort: request.reasoningEffort },
    ...(request.maxOutputTokens === undefined ? {} : { max_output_tokens: request.maxOutputTokens }),
    stream: true,
    // Nothing is kept on OpenAI's side: each turn sends its whole context.
    store: false,
  };
}

export interface SseEvent {
  event: string | undefined;
  data: string;
}

/** Server-sent events: blocks separated by a blank line, `event:` and `data:` fields, `:` lines are comments. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // A CR at the end of a chunk may be the first half of a CRLF split across chunks.
  let pendingCr = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      let text: string = (pendingCr ? "\r" : "") + decoder.decode(value, { stream: true });
      pendingCr = text.endsWith("\r");
      if (pendingCr) text = text.slice(0, -1);
      buffer += text.replace(/\r\n?/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = parseBlock(block);
        if (event) yield event;
      }
    }
    const last = parseBlock(buffer + decoder.decode());
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

/** One block's fields: `event:` names it, each `data:` line adds a line of data. A block with no data is none. */
export function parseBlock(block: string): SseEvent | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
}

interface WireResponse {
  id?: string;
  usage?: WireUsage;
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string; message?: string } | null;
}

interface WireEvent {
  type: string;
  delta?: string;
  item_id?: string;
  arguments?: string;
  item?: { id?: string; type?: string; call_id?: string; name?: string };
  response?: WireResponse;
  code?: string | null;
  message?: string;
}

const toUsage = (usage: WireUsage | undefined): Usage => ({
  inputTokens: usage?.input_tokens,
  outputTokens: usage?.output_tokens,
  reasoningTokens: usage?.output_tokens_details?.reasoning_tokens,
});

/** Streams one response. Throws `ResponsesApiError` for an HTTP error, an `error` event or a failed response. */
export async function* streamResponses(request: ResponsesRequest, deps: ResponsesDeps): AsyncGenerator<ResponsesEvent> {
  const fetch = deps.fetch ?? globalThis.fetch;
  const response = await fetch(`${deps.baseUrl ?? "https://api.openai.com/v1"}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${deps.apiKey}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(buildRequestBody(request)),
    signal: deps.signal,
  });
  if (!response.ok || !response.body) throw await httpError(response);

  // A function call's name and call id come with its output item; its arguments follow as deltas keyed by item id.
  const calls = new Map<string, { callId: string; name: string }>();
  let sawToolCall = false;

  for await (const { data } of parseSse(response.body)) {
    if (data === "[DONE]") continue;
    const event = JSON.parse(data) as WireEvent;
    switch (event.type) {
      case "response.output_text.delta":
        if (event.delta) yield { type: "text-delta", delta: event.delta };
        break;
      case "response.output_item.added":
        if (event.item?.type === "function_call" && event.item.id) {
          calls.set(event.item.id, { callId: event.item.call_id ?? "", name: event.item.name ?? "" });
        }
        break;
      case "response.function_call_arguments.done": {
        const call = event.item_id ? calls.get(event.item_id) : undefined;
        if (!call) throw new ResponsesApiError(`arguments for an unknown call ${event.item_id}`, undefined, undefined);
        sawToolCall = true;
        yield { type: "tool-call", callId: call.callId, name: call.name, arguments: event.arguments ?? "" };
        break;
      }
      case "response.completed":
        yield {
          type: "finish",
          finishReason: sawToolCall ? "tool-calls" : "stop",
          usage: toUsage(event.response?.usage),
          responseId: event.response?.id,
        };
        return;
      case "response.incomplete":
        yield {
          type: "finish",
          finishReason: event.response?.incomplete_details?.reason === "max_output_tokens" ? "length" : "other",
          usage: toUsage(event.response?.usage),
          responseId: event.response?.id,
        };
        return;
      case "response.failed":
        throw new ResponsesApiError(
          event.response?.error?.message ?? "the response failed",
          undefined,
          event.response?.error?.code,
        );
      case "error":
        throw new ResponsesApiError(event.message ?? "stream error", undefined, event.code ?? undefined);
    }
  }
  throw new ResponsesApiError("the stream ended before the response completed", undefined, undefined);
}

async function httpError(response: Response): Promise<ResponsesApiError> {
  const text = await response.text().catch(() => "");
  try {
    const { error } = JSON.parse(text) as { error?: { message?: string; code?: string } };
    if (error?.message) return new ResponsesApiError(error.message, response.status, error.code);
  } catch {
    // not JSON: fall through
  }
  return new ResponsesApiError(`HTTP ${response.status}`, response.status, undefined);
}

/**
 * Our messages as Responses input items. With `store: false` nothing is kept between turns, so an assistant turn's
 * calls go back as `function_call` items and their results as `function_call_output`, which is always a string.
 */
export function toInputItems(messages: ChatMessage[]): ResponsesInputItem[] {
  // 🐨 Turn each of our messages into the input items OpenAI wants, in order (one message can become
  //    several items):
  //    - a user turn: `{ role: "user", content }`.
  //    - an assistant turn: its text as `{ role: "assistant", content }`, then one `function_call` item per
  //      tool call it made: `{ type: "function_call", call_id, name, arguments }`. Leave the text item out
  //      when the turn has calls and no text.
  //    - a tool result: one `{ type: "function_call_output", call_id, output }`.
  // 🐨 `arguments` and `output` are strings of JSON. A call's input that's already a string (arguments the
  //    model wrote that didn't parse) goes as it is; anything else, JSON.stringify it. An error result
  //    (`isError`) goes as `{"error": "<the message>"}`.
  //
  // 💰 `messages.flatMap((message) => [...])` lets one message make zero, one or many items.
  //    `switch (message.role)` narrows the type in each case. `typeof x === "string"`.
  //
  // 🦉 Why the call goes back, not just its result. Every request sends `store: false`, so OpenAI keeps
  //    nothing between turns: the model has no memory that it asked for a search. Turn 2 has to replay the
  //    whole exchange, the question, the call, and its output. Send only the output and the API answers
  //    400: "No tool call found for function call output with call_id ...".
  // 🦉 Why `call_id`, and not the item's `id`. The stream names a call twice. Its output item has an `id`
  //    (`fc_...`) that the argument deltas use to say which call they belong to, inside one reply. Its
  //    `call_id` (`call_...`) is what ties the result to the call across turns. The client already pairs
  //    them up; your messages carry the `call_...` one as `callId`.
  // 🦉 Why strings. A function's output can be anything, so the wire takes text and lets you choose the
  //    format. JSON keeps the passages' structure for the model to read. And arguments go back exactly as
  //    the model wrote them, so the replayed turn matches what it really said.
  // 🦉 New in this file, already written: tools in the request body (each one `strict`, with
  //    `additionalProperties: false`), `tool_choice`, the stream's function calls (an `output_item.added`
  //    gives the name and call id, then `function_call_arguments.delta` events carry the arguments until
  //    `.done`), a "tool-calls" finish, and responsesChatModel passing tools in and calls out. toInputItems
  //    replaces step 2's textItems.
  //
  // 📜 https://platform.openai.com/docs/guides/function-calling
  // 📜 https://platform.openai.com/docs/api-reference/responses/create (the `input` items)
  //
  // 🚨 The tests check text turns, a call as a function_call item with its arguments as a string, no empty
  //    assistant text beside a call, a result as function_call_output with the same call_id, an error as
  //    {"error": ...}, and that the recorded exchange's second request comes out exactly as it was sent:
  //    the question, call_IyXA5wBnbLEOgiPMVwEOKVJR's search, and its two passages.
  throw new Error(`toInputItems(${messages.length} messages) isn't written yet`);
}

/** Arguments that aren't JSON stay a string, so the loop can answer the call with a validation error. */
function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The hand-written client as a `ChatModel`. */
export function responsesChatModel(deps: Omit<ResponsesDeps, "signal"> & { model: string }): ChatModel {
  return {
    id: `responses:${deps.model}`,

    async *stream(request) {
      const events = streamResponses(
        {
          model: deps.model,
          instructions: request.instructions,
          input: toInputItems(request.messages),
          tools: request.tools?.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
          toolChoice: request.toolChoice,
          reasoningEffort: request.reasoningEffort,
          maxOutputTokens: request.maxOutputTokens,
        },
        { ...deps, signal: request.abortSignal },
      );
      for await (const event of events) {
        if (event.type === "text-delta") yield event;
        else if (event.type === "tool-call")
          yield { type: "tool-call", callId: event.callId, name: event.name, input: parseArguments(event.arguments) };
        else if (event.type === "finish")
          yield { type: "finish", finishReason: event.finishReason, usage: event.usage };
      }
    },
  };
}
