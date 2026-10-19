/**
 * What every durable runner (the job queue, Workflow) needs to decide about a failure, and how a side effect
 * stays single when its step runs again.
 */
import type { AgentTool } from "#learn/agent/types";

import { RunHalted } from "#learn/agent/loop";

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

const fields = (error: unknown) => (error && typeof error === "object" ? (error as Record<string, unknown>) : {});

/**
 * Whether trying again could work: a 408, 429 or 5xx answer, a dropped or refused connection, a timeout. A
 * halted run, a 4xx, a bad request or a bug fails the same way every time, so it isn't. Looks through `cause`
 * (fetch wraps network errors in a TypeError) and `lastError` (the AI SDK's RetryError).
 */
export function isRetryable(error: unknown): boolean {
  for (let e = error, depth = 0; e && depth < 5; depth++) {
    if (e instanceof RunHalted) return false;
    const f = fields(e);
    const status = typeof f.statusCode === "number" ? f.statusCode : f.status;
    if (typeof status === "number") return status === 408 || status === 429 || status >= 500;
    if (typeof f.isRetryable === "boolean") return f.isRetryable;
    if (typeof f.code === "string" && NETWORK_CODES.has(f.code)) return true;
    if (f.name === "TimeoutError") return true;
    e = f.lastError ?? f.cause;
  }
  return false;
}

/** How long to wait before attempt `attempt + 1`: doubling from `baseMs`, capped. */
export const backoffMs = (attempt: number, baseMs = 1_000, maxMs = 60_000) =>
  Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));

/** What a model turn step does after its turn threw. */
export type TurnFailure =
  | { kind: "cancelled" }
  | { kind: "halted"; reason: string }
  | { kind: "retry"; message: string; afterMs: number }
  | { kind: "fatal"; message: string };

export interface TurnFailureContext {
  /** The run's own signal: the user cancelled it. */
  cancelled: boolean;
  /** The step's own timeout fired. */
  timedOut: boolean;
  /** Which attempt of the step this was, from 1. */
  attempt: number;
  /** The wait before the retry, when the caller sets one (data, so tests can make it small). */
  retryAfterMs?: number;
}

/**
 * Sorts a failed model turn (section 15.5). A cancel isn't a failure: the body already knows, so the error goes up
 * as it is. A halted run (the kill switch, the daily budget) fails the run. The step's own timeout, a rate limit, a
 * 5xx or a dropped connection is tried again after a wait; anything else fails the step for good.
 */
export function turnFailure(error: unknown, context: TurnFailureContext): TurnFailure {
  if (context.cancelled) return { kind: "cancelled" };
  if (error instanceof RunHalted) return { kind: "halted", reason: error.reason };
  const message = error instanceof Error ? error.message : String(error);
  if (context.timedOut || isRetryable(error)) {
    return { kind: "retry", message, afterMs: context.retryAfterMs ?? backoffMs(context.attempt) };
  }
  return { kind: "fatal", message };
}

/**
 * A write's idempotency key inside Workflow: the step's `stepId`, which stays the same across the step's retries
 * and replays. Run again after a crash, the step sends the same key, so the other side does the write once.
 */
export const stepIdempotencyKey = (runId: string, stepId: string) => `agent:${runId}:${stepId}`;

/** The tools, each handed `key` as its idempotency key instead of the one the loop derives. */
export function withIdempotencyKey(tools: readonly AgentTool[], key: string): AgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: (input, ctx) => tool.execute(input, { ...ctx, idempotencyKey: key }),
  }));
}
