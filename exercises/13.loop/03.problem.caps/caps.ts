// 👨‍💼 An agent decides for itself how many turns to take. A model stuck in a loop (searching, finding nothing,
//    searching again) would go on spending Grace's tokens until someone noticed. So every run has caps: at most 12
//    model turns, 30 tool calls, 60,000 tokens and 10 minutes of work. This file counts what a run has used and says
//    when it has to stop.
//
// 🦉 Already written in this file: `DEFAULT_CAPS`, and `turnEstimate` (step 6's). The reference `decide` calls your
//    two functions: `capReached(usage, caps)` before each model turn, and `capReached(usage, caps, n)` before a
//    batch of n calls. You write `runUsage` and `capReached`.

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
  // 🐨 Walk the events once and count:
  //    - model turns: each `assistant_turn`;
  //    - tool calls: each `tool_result` (a call with no result hasn't run yet);
  //    - tokens: each turn's output, plus the input it sent beyond what the previous turn sent (never below 0);
  //    - active time: the time spent `running`.
  // 🐨 A `tool_result` can carry a sub-agent's spend as `usage` (section 16): add its `tokens` and `toolCalls` too.
  // 🐨 Active time comes from `status` events. A span starts when the status becomes `running` and ends at the
  //    next status change; a span still open ends at the latest event. A log with no status yet counts as running
  //    from its first event.
  // 🐨 The classic mistake: adding each turn's whole input. Every turn sends the whole conversation again, so the
  //    user's message would be counted once per turn.
  //
  // 💰 `Date.parse(event.at)` gives milliseconds. `data.usage.inputTokens ?? 0`. `Math.max(0, n)`.
  //
  // 🦉 Why only the new input. Grace's turns sent 1,865, 1,949, 4,109, 6,532 and 6,750 tokens: each one repeats
  //    everything before it and adds the latest results. Summed, that's 21,205, with her first message counted five
  //    times. What her run actually grew by is the last context, 6,750, plus 507 tokens of output: 7,257. After a
  //    compaction (section 14) the input drops, adds nothing, and only what grows after it counts. The daily
  //    budget (step 6) still charges all 21,712: that's what OpenAI bills.
  // 🦉 Why count from the events. A crashed run is picked up on another machine with nothing but its log. Counters
  //    kept in memory would start again at 0, and a run that crashed every tenth turn would never stop.
  // 🦉 Why waiting doesn't count. A run waiting a day for an approval costs nothing. The time cap is for a run
  //    stuck working, so it counts only the spans spent running.
  //
  // 🚨 The tests check each count on small logs, a compacted context, a sub-agent's spend, a run that waits a
  //    day, and Grace's 7,257.
  throw new Error(`runUsage(${events.length} events) isn't written yet`);
}

/** The first cap reached before a model turn, or before `toolCalls` more calls; null when there's room. */
export function capReached(usage: RunUsage, caps: Caps, toolCalls = 0): string | null {
  // 🐨 Before a model turn (`toolCalls` is 0) the run stops if it has used up its active time, its tokens or its
  //    model turns. Before a batch of `toolCalls` calls it stops if its active time or tokens are used up, or if
  //    the batch would take it past its tool calls.
  // 🐨 The reason names the cap: `cap reached: <seconds> s of active time`, `cap reached: <n> tokens`, `cap
  //    reached: <n> model turns`, `cap reached: <n> tool calls`. Check them in that order. Room left: null.
  // 🐨 The classic mistake: checking only the calls already made. With 28 of 30 made and a batch of 5 waiting, 28
  //    is under 30, and the batch takes the run to 33. Count the batch in before it runs.
  //
  // 🦉 Why before. A cap checked after the work has already been spent. `decide` asks before every model turn and
  //    every batch, so a run stops short of the line, never past it.
  // 🦉 Why the turn cap waits for a turn. It caps model calls. The 12th turn's calls still run (they have their
  //    own cap), and the run stops before a 13th.
  //
  // 🚨 The tests check every cap, the order, the messages, a batch counted before it runs, and Grace's run under
  //    a 10,000-token cap.
  throw new Error(`capReached(${JSON.stringify(usage)}, ${JSON.stringify(caps)}, ${toolCalls}) isn't written yet`);
}

/** Output tokens assumed for a call that sets no `maxOutputTokens`. */
export const DEFAULT_OUTPUT_ESTIMATE = 4_000;

/** What a model call may cost before it's made: its request's tokens plus the most it may write. The daily budget
 * holds this much while the call runs. */
export function turnEstimate(request: Pick<ChatRequest, "instructions" | "messages" | "tools" | "maxOutputTokens">) {
  const sent = countTokens(request.instructions) + countTokens(JSON.stringify([request.messages, request.tools ?? []]));
  return sent + (request.maxOutputTokens ?? DEFAULT_OUTPUT_ESTIMATE);
}
