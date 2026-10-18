/**
 * Recorded model traffic (`fixtures/cassettes/model/`): the request body we sent and the raw bytes that came back,
 * recorded once against OpenAI on 2026-10-18 and replayed by tests and the models lab, so nothing here calls OpenAI.
 * A replay answers the nth call with the nth recording and ignores what the call sends (PLAN.md, "Grading with a
 * fake model"), so it grades the parsing, not the prompt.
 */
import type { RetrievedChunk } from "#learn/retrieve/types";

import answerRequest from "../../../fixtures/cassettes/model/answer.request.json?raw";
import answerBody from "../../../fixtures/cassettes/model/answer.sse?raw";
import rewriteRequest from "../../../fixtures/cassettes/model/rewrite.request.json?raw";
import rewriteBody from "../../../fixtures/cassettes/model/rewrite.response.json?raw";
import sourcesJson from "../../../fixtures/cassettes/model/sources.json?raw";
import toolCall1Request from "../../../fixtures/cassettes/model/tool-call-1.request.json?raw";
import toolCall1Body from "../../../fixtures/cassettes/model/tool-call-1.sse?raw";
import toolCall2Request from "../../../fixtures/cassettes/model/tool-call-2.request.json?raw";
import toolCall2Body from "../../../fixtures/cassettes/model/tool-call-2.sse?raw";

export interface Cassette {
  name: CassetteName;
  /** What it shows, in a line. */
  title: string;
  /** The JSON body that was sent. */
  request: Record<string, unknown>;
  /** The answer as it came over the wire: server-sent events, or one JSON object. */
  body: string;
  contentType: "text/event-stream" | "application/json";
}

const RECORDINGS = {
  answer: {
    title: "A streamed answer: the chat prompt for the London hotel limit, with two sources",
    request: answerRequest,
    body: answerBody,
    contentType: "text/event-stream",
  },
  "tool-call-1": {
    title: "A tool call: the model asks search_documents for the London hotel limit",
    request: toolCall1Request,
    body: toolCall1Body,
    contentType: "text/event-stream",
  },
  "tool-call-2": {
    title: "The tool's result goes back, and the model answers from it",
    request: toolCall2Request,
    body: toolCall2Body,
    contentType: "text/event-stream",
  },
  rewrite: {
    title: "Structured output through the AI SDK: the query rewriter's search_queries object",
    request: rewriteRequest,
    body: rewriteBody,
    contentType: "application/json",
  },
} as const;

/** The two chunks the answer's prompt was built from, as retrieval returned them: version 2 of the expenses
 * policy (S1), then version 1 (S2). */
export const CASSETTE_SOURCES = JSON.parse(sourcesJson) as RetrievedChunk[];

/** The question every recording asks, but the rewrite (which takes it in other words). */
export const CASSETTE_QUESTION = "What is the hotel limit for a night in London?";

export type CassetteName = keyof typeof RECORDINGS;

export const CASSETTE_NAMES = Object.keys(RECORDINGS) as CassetteName[];

export function cassette(name: CassetteName): Cassette {
  const { title, request, body, contentType } = RECORDINGS[name];
  return { name, title, request: JSON.parse(request) as Record<string, unknown>, body, contentType };
}

/** A body that hands over `bytes` `readSize` at a time, as a network read would: the cuts fall anywhere. */
export function chunkedBody(bytes: Uint8Array, readSize = bytes.length): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + readSize));
      offset += readSize;
    },
  });
}

export interface ReplayedRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * A fetch that answers its nth call with the nth cassette, read `readSize` bytes at a time, and keeps what each
 * call sent in `requests`. A call past the list fails.
 */
export function cassetteFetch(
  names: CassetteName[],
  { readSize }: { readSize?: number } = {},
): { fetch: typeof globalThis.fetch; requests: ReplayedRequest[] } {
  const requests: ReplayedRequest[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const name = names[requests.length];
    requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    if (!name) throw new Error(`the replay holds ${names.length} recordings; call ${requests.length} has none`);
    const { body, contentType } = cassette(name);
    return new Response(chunkedBody(new TextEncoder().encode(body), readSize), {
      status: 200,
      headers: { "content-type": contentType },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}
