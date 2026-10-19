// 👨‍💼 The kill proof: Grace's send was held 15 seconds by fake-workspace, and the server running her run was
//    killed in the middle. The request had left; nobody saw the answer. When the run resumed, it sent again. Tom
//    must get one mail, not two. The only thing that can tell fake-workspace "this is the same mail" is a key that
//    both attempts send, and only the step knows what that key is.

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
export function stepIdempotencyKey(runId: string, stepId: string): string {
  // 🐨 Return the key for a write made by the step `stepId` of the run `runId`: `agent:<runId>:<stepId>`.
  //
  // 🦉 Why from the step. Workflow gives each step an id (`step_01M59S7Y...`) when the body first calls it, and
  //    keeps it: a retry, or a re-run after the server died, is the same step with the same id. So a key made from
  //    it is the same on every attempt, and the other side can see the second request is the first one again.
  // 🦉 Why not a random id, or the time. `crypto.randomUUID()` in the step makes a new key on every attempt, and
  //    a new key is a new mail. The key has to be decided by something that survives the crash: the step's id is
  //    in Workflow's log, so it does.
  // 🦉 Why not the model's call id, as the loop does outside Workflow (`agent:<run>:<callId>`). The call id is a
  //    string the model wrote. OpenAI's are unique, but nothing makes them so: scripted tests use "m1", and some
  //    models number their calls "call_0" every turn, so two different mails could share a key and the second
  //    would never go. The step's id comes from Workflow, which makes it unique.
  // 🦉 Why the run in it. Keys are per tenant's site at fake-workspace, and the run makes them easy to find: the
  //    kill proof counts a run's mails by the prefix `agent:<runId>:`.
  //
  // 🚨 The tests check the key's shape, that it's the same however often it's asked for, and different for
  //    another step or another run.
  throw new Error(`stepIdempotencyKey(${runId}, ${stepId}) isn't written yet`);
}

/** The tools, each handed `key` as its idempotency key instead of the one the loop derives. */
export function withIdempotencyKey(tools: readonly AgentTool[], key: string): AgentTool[] {
  // 🐨 Return a copy of each tool whose `execute` runs the original with the same input and the same context,
  //    except `idempotencyKey`, which is `key`. Leave the tools you were given as they are: other runs use them.
  //
  // 💰 `{ ...tool, execute: (input, ctx) => ... }` copies an object with one field replaced; so does
  //    `{ ...ctx, idempotencyKey: key }`.
  //
  // 🦉 Why wrap the tools instead of changing the loop. The loop (section 13) gives each call the key
  //    `agent:<run>:<callId>`, and knows nothing about Workflow. The tool step does know its own id. Wrapping the
  //    tools hands the step's key down to `send_mail` and `share_document` without the loop learning about steps.
  //
  // 🚨 The tests check that every tool sees `key`, that the rest of its context comes through, and that the
  //    tools passed in still see the loop's own key.
  throw new Error(`withIdempotencyKey(${tools.length} tools, ${key}) isn't written yet`);
}
