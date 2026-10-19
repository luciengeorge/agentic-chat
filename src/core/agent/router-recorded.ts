/**
 * The router on four messages, recorded once on gpt-6-luna (low effort) on 2026-10-19 by a script that isn't
 * committed, which called `routeMessage` with a fetch that kept each request body and the raw server-sent events.
 * Section 16.2 replays them, so nothing there calls a model.
 *
 * 1. "What's the daily meal allowance on a work trip?", no live run: `answer`.
 * 2. "Email Tom Whitfield the payment terms of KPC-2026-0142.", no live run: `agent`.
 * 3. "Compare what versions 1 and 2 of the travel and expenses policy say about hotels.", no live run: `agent`.
 * 4. "Actually, send it to Amara instead.", with a live run: `agent`.
 */
import { createOpenAI } from "@ai-sdk/openai";

import type { RouteDecision, RouteInput } from "#learn/agent/router";
import type { ChatModel } from "#learn/model/types";

import { aiSdkChatModel } from "#learn/model/ai-sdk";
import { CHAT_MODEL } from "#learn/model/config";
import { chunkedBody } from "@/core/model/cassette";

import router from "../../../fixtures/cassettes/agent/router.json?raw";

export interface RecordedRoute {
  input: RouteInput;
  /** What `routeMessage` returned when it was recorded. */
  decision: RouteDecision;
  /** The request body the AI SDK sent, and the raw reply. */
  request: Record<string, unknown>;
  sse: string;
  ms: number;
}

export interface RouterRecording {
  recorded: string;
  model: string;
  reasoningEffort: string;
  calls: RecordedRoute[];
}

export function routerRecording(): RouterRecording {
  return JSON.parse(router) as RouterRecording;
}

/**
 * gpt-6-luna through the AI SDK's own OpenAI provider, answering with the recorded reply to message `index`
 * whatever the request says. `requests` holds what each call sent.
 */
export function replayRouterModel(index: number): { model: ChatModel; requests: Array<Record<string, unknown>> } {
  const call = routerRecording().calls[index];
  if (!call) throw new Error(`the router recording has no message ${index}`);
  const requests: Array<Record<string, unknown>> = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    if (requests.length > 1)
      throw new Error("the recording has one router call per message; the model was called again");
    init?.signal?.throwIfAborted();
    return new Response(chunkedBody(new TextEncoder().encode(call.sse)), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const openai = createOpenAI({ apiKey: "replay", fetch: fetch as typeof globalThis.fetch });
  return { model: aiSdkChatModel(openai(CHAT_MODEL)), requests };
}
