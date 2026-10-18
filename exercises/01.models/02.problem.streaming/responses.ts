// 👨‍💼 Kestrel's assistant shows its answer while gpt-6-luna is still writing it: the first words appear in
//    under a second, though the whole answer takes several. That only works if the app can read the
//    reply as it arrives. OpenAI sends it as server-sent events, and this file reads them by hand.

import type { ChatMessage, ChatModel, FinishReason, ReasoningEffort, Usage } from "#learn/model/types";

/**
 * A hand-written client for OpenAI's Responses API (`POST /v1/responses`), streaming only. It shows the wire
 * format the AI SDK hides: the request body, and the server-sent events the reply arrives as. Text turns only,
 * for now.
 */

export type ResponsesInputItem = { role: "user" | "assistant" | "developer"; content: string };

export interface ResponsesRequest {
  model: string;
  instructions?: string;
  input: ResponsesInputItem[];
  reasoningEffort: ReasoningEffort;
  maxOutputTokens?: number;
}

export type ResponsesEvent =
  | { type: "text-delta"; delta: string }
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
  // 🐨 Read the body with `body.getReader()`, one `read()` at a time, until it says `done`. Keep two things
  //    between reads: one TextDecoder, and a buffer of the text you've decoded but not yet used.
  // 🐨 Decode each read with `{ stream: true }`, change every CRLF (and lone CR) into LF, and add it to the
  //    buffer. Then, while the buffer holds a blank line ("\n\n"), cut off the block before it, hand the
  //    block to parseBlock, and yield the event if there is one. Whatever is after the last blank line
  //    stays in the buffer for the next read.
  // 🐨 When the reads are done, the buffer may still hold one last event with no blank line after it.
  //    Yield that too. Release the reader at the end, even if the caller stops early (try/finally).
  //
  // 💰 `const { value, done } = await reader.read()`. `decoder.decode(value, { stream: true })`, and a
  //    final `decoder.decode()` with no arguments flushes what it held back. `text.replace(/\r\n?/g, "\n")`.
  //    `buffer.indexOf("\n\n")` finds a blank line. `reader.releaseLock()`.
  //
  // 🦉 Why a buffer. The network hands you bytes in reads of whatever size it likes, and they don't line
  //    up with events. Read the recorded answer 1,024 bytes at a time and 21 of its 64 events are cut
  //    across two reads. A blank line is the only thing that says "this event is complete", so text waits
  //    in the buffer until one arrives.
  // 🦉 Why one decoder, with `stream: true`. A read can end in the middle of a character. "£" is two bytes
  //    in UTF-8, C2 A3; if a read ends after C2, a fresh decoder has half a character and writes "�"
  //    instead. A decoder in stream mode keeps the C2 back and joins it to the A3 at the start of the next
  //    read.
  // 🦉 Why the CR needs care. Servers may end lines with CRLF ("\r\n"). If a read ends right after the CR,
  //    changing it to LF at once and then the LF at the start of the next read to another LF makes two
  //    line breaks out of one: a blank line, and an event cut in half. So a CR at the very end of a read
  //    waits until you see what comes next.
  // 🦉 New in this file, already written: buildRequestBody (the request), parseBlock (one block's fields,
  //    with comments and multi-line data), streamResponses (fetch, then your events turned into text deltas
  //    and a finish), and responsesChatModel, the client as a ChatModel.
  //
  // 📜 https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
  // 📜 https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder/decode
  //
  // 🚨 The tests check that the recorded answer gives the same 64 events however its bytes are cut (one
  //    read, 1,024 bytes, 7, or 1 at a time), that a "£" cut between its two bytes arrives whole, that a
  //    CRLF cut between CR and LF stays one line break, that the last event counts without a blank line
  //    after it, and that the client then streams the recorded answer and its bill: 598 tokens in, 113 out.
  throw new Error(`parseSse(${body.locked ? "a locked" : "a"} body) isn't written yet`);
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

  for await (const { data } of parseSse(response.body)) {
    if (data === "[DONE]") continue;
    const event = JSON.parse(data) as WireEvent;
    switch (event.type) {
      case "response.output_text.delta":
        if (event.delta) yield { type: "text-delta", delta: event.delta };
        break;
      case "response.completed":
        yield {
          type: "finish",
          finishReason: "stop",
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

/** Our text turns as Responses input items. Tool calls and their results come in step 3. */
function textItems(messages: ChatMessage[]): ResponsesInputItem[] {
  return messages.map((message) => {
    if (message.role === "tool") throw new ResponsesApiError("tool results come in step 3", undefined, undefined);
    return { role: message.role, content: message.content };
  });
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
          input: textItems(request.messages),
          reasoningEffort: request.reasoningEffort,
          maxOutputTokens: request.maxOutputTokens,
        },
        { ...deps, signal: request.abortSignal },
      );
      for await (const event of events) {
        if (event.type === "text-delta") yield event;
        else yield { type: "finish", finishReason: event.finishReason, usage: event.usage };
      }
    },
  };
}
