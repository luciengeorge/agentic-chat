/**
 * Four chat turns recorded once against the dev stack on 2026-10-18 (real embeddings, the real rewriter, Cohere,
 * gpt-6-luna at medium), replayed by sections 10 and 11 and the prompt lab, so nothing there calls a model. Each
 * holds the question, who asked it, the 30 chunks retrieval returned at k = 30 (the app answers from the first 8),
 * the request the AI SDK sent for those 8, and the raw server-sent events that came back. Recorded by a script that
 * isn't committed: it ran `createRetrieve` and `answer` as `pnpm eval` does, with a fetch that kept the bytes.
 *
 * - `london-hotel`: leo.martin, "What is the hotel limit for a night in London?". Version 1 of the expenses policy
 *   ranks first; the answer prefers version 2 and says the old limit differs.
 * - `heron`: leo.martin, "What is Project Heron, and how much is Kestrel paying?". He can't read `/Exec`, so none of
 *   his 8 sources mention it, and the model abstains. S2 is the Brightwell pack, injection and all.
 * - `brightwell`: ella.brooks asks about the Brightwell launch. All 8 sources are the onboarding pack, the hidden
 *   instructions included; the answer cites S1 and S3 and ignores them.
 * - `invoice-hold`: grace.adeyemi asks why the Brindle invoice is on hold. S1 is OCR text; one of the three
 *   citations tidies its noise and is dropped. At k = 30 her sources overflow the 6,000-token budget.
 *
 * A replay answers with the recorded bytes whatever the request says (PLAN.md, "Grading with a fake model"), so a
 * prompt built differently still gets the recorded reply.
 */
import { createOpenAI } from "@ai-sdk/openai";

import type { ChatModel, StructuredModel } from "#learn/model/types";
import type { RetrievedChunk } from "#learn/retrieve/types";

import { aiSdkChatModel } from "#learn/model/ai-sdk";
import { CHAT_MODEL } from "#learn/model/config";
import { chunkedBody } from "@/core/model/cassette";

import brightwellJson from "../../../fixtures/cassettes/generate/brightwell.json?raw";
import brightwellRequest from "../../../fixtures/cassettes/generate/brightwell.request.json?raw";
import brightwellSse from "../../../fixtures/cassettes/generate/brightwell.sse?raw";
import heronJson from "../../../fixtures/cassettes/generate/heron.json?raw";
import heronRequest from "../../../fixtures/cassettes/generate/heron.request.json?raw";
import heronSse from "../../../fixtures/cassettes/generate/heron.sse?raw";
import invoiceJson from "../../../fixtures/cassettes/generate/invoice-hold.json?raw";
import invoiceRequest from "../../../fixtures/cassettes/generate/invoice-hold.request.json?raw";
import invoiceSse from "../../../fixtures/cassettes/generate/invoice-hold.sse?raw";
import londonJson from "../../../fixtures/cassettes/generate/london-hotel.json?raw";
import londonRequest from "../../../fixtures/cassettes/generate/london-hotel.request.json?raw";
import londonSse from "../../../fixtures/cassettes/generate/london-hotel.sse?raw";

export interface RecordedTurn {
  recorded: string;
  name: TurnName;
  tenant: "kestrel" | "harbour";
  /** The world username who asked. */
  user: string;
  question: string;
  chatModel: string;
  rerankModel: string;
  rewritten: string[];
  /** What retrieval returned at k = 30, best first. The app's k is 8: the first 8 are what the model saw. */
  chunks: RetrievedChunk[];
  /** The request body the AI SDK sent for the first 8. */
  request: Record<string, unknown>;
  /** The reply as it came over the wire: OpenAI's server-sent events. */
  sse: string;
}

const RECORDINGS = {
  "london-hotel": [londonJson, londonRequest, londonSse],
  heron: [heronJson, heronRequest, heronSse],
  brightwell: [brightwellJson, brightwellRequest, brightwellSse],
  "invoice-hold": [invoiceJson, invoiceRequest, invoiceSse],
} as const;

export type TurnName = keyof typeof RECORDINGS;

export const TURN_NAMES = Object.keys(RECORDINGS) as TurnName[];

/** The app's k: how many of a recording's chunks the model saw. */
export const APP_K = 8;

export function recordedTurn(name: TurnName): RecordedTurn {
  const [json, request, sse] = RECORDINGS[name];
  return { ...(JSON.parse(json) as Omit<RecordedTurn, "request" | "sse">), request: JSON.parse(request), sse };
}

export interface ReplayOptions {
  /** Bytes handed over per read (all at once by default). */
  readSize?: number;
  /** A wait before each read, so a test can abort mid-answer. */
  delayMs?: number;
}

/**
 * gpt-6-luna through the AI SDK's own OpenAI provider, answering every call with one recording's bytes. It honours
 * the call's abort signal, as a real connection would. `requests` holds what each call sent.
 */
export function replayModel(
  name: TurnName,
  { readSize, delayMs = 0 }: ReplayOptions = {},
): { model: ChatModel & StructuredModel; requests: Array<Record<string, unknown>> } {
  const requests: Array<Record<string, unknown>> = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();
    const source = chunkedBody(new TextEncoder().encode(recordedTurn(name).sse), readSize).getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (signal?.aborted) return controller.error(signal.reason);
        const { value, done } = await source.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel: (reason) => source.cancel(reason),
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const openai = createOpenAI({ apiKey: "replay", fetch: fetch as typeof globalThis.fetch });
  return { model: aiSdkChatModel(openai(CHAT_MODEL)), requests };
}

/** The reply's text, read straight from the recorded events: every `response.output_text.delta`, joined. */
export function recordedReply(name: TurnName): string {
  return recordedTurn(name)
    .sse.split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as { type?: string; delta?: string })
    .filter((data) => data.type === "response.output_text.delta")
    .map((data) => data.delta)
    .join("");
}
