import type { RunEvent } from "#learn/agent/types";
import type { ChatRequest } from "#learn/model/types";

import { countTokens } from "#learn/model/tokens";

/** Per-run limits. A run that reaches one finishes `failed`, with the cap as the reason. */
export interface Caps {
  modelTurns: number;
  toolCalls: number;
  /**
   * Tokens over every model turn: each turn's output, plus its input beyond the previous turn's (at least 0, so a
   * compacted context adds nothing). A sub-agent's tokens count against its parent's.
   */
  tokens: number;
  /** Time spent running. Waiting on the user (an approval, a message) doesn't count. */
  activeMs: number;
}

export const DEFAULT_CAPS: Caps = { modelTurns: 12, toolCalls: 30, tokens: 60_000, activeMs: 10 * 60_000 };

export interface RunUsage {
  modelTurns: number;
  /** Tool calls that have a result, plus the calls of the sub-agents they started. */
  toolCalls: number;
  tokens: number;
  activeMs: number;
}

/**
 * What the run has used so far, from its events alone. Active time adds up the spans in which the run's status
 * was `running`, the last one up to the latest event. A log with no status events yet counts as running from its
 * first event.
 *
 * Tokens count what each turn added: its output, and the input the previous turn didn't already have. Every turn
 * resends the whole context, so summing full inputs would charge the first message once per turn, and a run would
 * hit the cap after a few turns however well compaction kept its context small. (The daily budget still charges
 * the full usage: that's what the provider bills.) A `tool_result` that carries a sub-agent's `usage` adds it.
 */
export function runUsage(events: readonly RunEvent[]): RunUsage {
  const usage: RunUsage = { modelTurns: 0, toolCalls: 0, tokens: 0, activeMs: 0 };
  let runningSince: number | null = events.length ? Date.parse(events[0].at) : null;
  let previousInput = 0;
  for (const { at, data } of events) {
    const time = Date.parse(at);
    if (data.type === "assistant_turn") {
      const input = data.usage.inputTokens ?? 0;
      usage.modelTurns += 1;
      usage.tokens += Math.max(0, input - previousInput) + (data.usage.outputTokens ?? 0);
      previousInput = input;
    } else if (data.type === "tool_result") {
      usage.toolCalls += 1 + (data.usage?.toolCalls ?? 0);
      usage.tokens += data.usage?.tokens ?? 0;
    } else if (data.type === "status") {
      if (runningSince !== null) usage.activeMs += time - runningSince;
      runningSince = data.to === "running" ? time : null;
    }
  }
  if (runningSince !== null && events.length) usage.activeMs += Date.parse(events.at(-1)!.at) - runningSince;
  return usage;
}

/** The first cap reached before a model turn, or before `toolCalls` more calls; null when there's room. */
export function capReached(usage: RunUsage, caps: Caps, toolCalls = 0): string | null {
  if (usage.activeMs >= caps.activeMs) return `cap reached: ${caps.activeMs / 1000} s of active time`;
  if (usage.tokens >= caps.tokens) return `cap reached: ${caps.tokens} tokens`;
  if (toolCalls === 0 && usage.modelTurns >= caps.modelTurns) return `cap reached: ${caps.modelTurns} model turns`;
  if (toolCalls > 0 && usage.toolCalls + toolCalls > caps.toolCalls) return `cap reached: ${caps.toolCalls} tool calls`;
  return null;
}

/** Output tokens assumed for a call that sets no `maxOutputTokens`. */
export const DEFAULT_OUTPUT_ESTIMATE = 4_000;

/** What a model call may cost before it's made: its request's tokens plus the most it may write. The daily budget
 * holds this much while the call runs. */
export function turnEstimate(request: Pick<ChatRequest, "instructions" | "messages" | "tools" | "maxOutputTokens">) {
  const sent = countTokens(request.instructions) + countTokens(JSON.stringify([request.messages, request.tools ?? []]));
  return sent + (request.maxOutputTokens ?? DEFAULT_OUTPUT_ESTIMATE);
}
