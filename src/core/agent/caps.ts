import type { RunEvent } from "./types";

/** Per-run limits. A run that reaches one finishes `failed`, with the cap as the reason. */
export interface Caps {
  modelTurns: number;
  toolCalls: number;
  /** Input plus output tokens over every model turn. */
  tokens: number;
  /** Time spent running. Waiting on the user (an approval, a message) doesn't count. */
  activeMs: number;
}

export const DEFAULT_CAPS: Caps = { modelTurns: 12, toolCalls: 30, tokens: 60_000, activeMs: 10 * 60_000 };

export interface RunUsage {
  modelTurns: number;
  /** Tool calls that have a result. */
  toolCalls: number;
  tokens: number;
  activeMs: number;
}

/**
 * What the run has used so far, from its events alone. Active time adds up the spans in which the run's status
 * was `running`, the last one up to the latest event. A log with no status events yet counts as running from its
 * first event.
 */
export function runUsage(events: readonly RunEvent[]): RunUsage {
  const usage: RunUsage = { modelTurns: 0, toolCalls: 0, tokens: 0, activeMs: 0 };
  let runningSince: number | null = events.length ? Date.parse(events[0].at) : null;
  for (const { at, data } of events) {
    const time = Date.parse(at);
    if (data.type === "assistant_turn") {
      usage.modelTurns += 1;
      usage.tokens += (data.usage.inputTokens ?? 0) + (data.usage.outputTokens ?? 0);
    } else if (data.type === "tool_result") {
      usage.toolCalls += 1;
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
