/**
 * The judge's and the claim checker's model calls on the faithfulness set, recorded once against OpenAI by
 * `pnpm eval:judge --record` and replayed by tests, `pnpm eval:judge` and the eval dashboard, so none of them call a
 * model. Each file holds, per item, every call's request body and the raw JSON that came back.
 *
 * - `judge.json`: one call per item (`judgeFaithfulness`).
 * - `claims.json`: two per item, `decomposeClaims` then `checkClaims` (one, for an answer with no claims).
 *
 * A replay answers an item's nth call with its nth recording, whatever the request says (PLAN.md, "Grading with a
 * fake model"), so a prompt changed since the recording still gets the recorded verdict.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { StructuredModel } from "#learn/model/types";

import { aiSdkChatModel } from "#learn/model/ai-sdk";
import { CHAT_MODEL } from "#learn/model/config";

export type EvalRecordingName = "judge" | "claims";

export interface RecordedCall {
  request: Record<string, unknown>;
  /** The response body as it came over the wire (OpenAI's Responses API JSON). */
  response: string;
  status: number;
  ms: number;
}

export interface EvalRecording {
  recorded: string;
  model: string;
  reasoningEffort: string;
  calls: Record<string, RecordedCall[]>;
}

const DIR = join(import.meta.dirname, "../../../fixtures/cassettes/eval");

export const evalRecordingPath = (name: EvalRecordingName) => join(DIR, `${name}.json`);

const cache = new Map<EvalRecordingName, EvalRecording>();

export function evalRecording(name: EvalRecordingName): EvalRecording | null {
  if (!cache.has(name)) {
    const path = evalRecordingPath(name);
    if (!existsSync(path)) return null;
    cache.set(name, JSON.parse(readFileSync(path, "utf8")) as EvalRecording);
  }
  return cache.get(name)!;
}

export function writeEvalRecording(name: EvalRecordingName, recording: EvalRecording): void {
  writeFileSync(evalRecordingPath(name), `${JSON.stringify(recording, null, 2)}\n`);
  cache.set(name, recording);
}

/** gpt-6-luna through the AI SDK's OpenAI provider, answering an item's nth call with its nth recorded reply. */
export function replayEvalModel(name: EvalRecordingName, itemId: string): StructuredModel {
  const calls = evalRecording(name)?.calls[itemId];
  if (!calls) throw new Error(`fixtures/cassettes/eval/${name}.json has no calls for ${itemId}`);
  let n = 0;
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const call = calls[n++];
    if (!call) throw new Error(`${name}.json has ${calls.length} calls for ${itemId}; the model was called again`);
    init?.signal?.throwIfAborted();
    return new Response(call.response, { status: call.status, headers: { "content-type": "application/json" } });
  };
  const openai = createOpenAI({ apiKey: "replay", fetch: fetch as typeof globalThis.fetch });
  return aiSdkChatModel(openai(CHAT_MODEL));
}

/** A fetch that passes each call through and keeps what was sent and what came back, for `--record`. */
export function recordingFetch(into: RecordedCall[]): typeof globalThis.fetch {
  return async (url, init) => {
    const started = performance.now();
    const response = await globalThis.fetch(url, init);
    const body = await response.text();
    into.push({
      request: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      response: body,
      status: response.status,
      ms: Math.round(performance.now() - started),
    });
    return new Response(body, { status: response.status, headers: response.headers });
  };
}

export interface ResponseUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** The usage OpenAI reported in a recorded Responses API body. */
export function recordedUsage(call: RecordedCall): ResponseUsage {
  const usage = (JSON.parse(call.response) as { usage?: Record<string, unknown> }).usage ?? {};
  const input = usage.input_tokens_details as { cached_tokens?: number } | undefined;
  const output = usage.output_tokens_details as { reasoning_tokens?: number } | undefined;
  return {
    inputTokens: Number(usage.input_tokens ?? 0),
    cachedInputTokens: input?.cached_tokens ?? 0,
    outputTokens: Number(usage.output_tokens ?? 0),
    reasoningTokens: output?.reasoning_tokens ?? 0,
  };
}
