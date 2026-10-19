// 👨‍💼 Grace's second turn asks for two things at once: search for the contract, and look Tom up. The search took
//    5.1 seconds (an embedding, two searches and a rerank); the lookup took 7 milliseconds. Run them one after the
//    other and every turn costs the sum of its calls. This step runs them together and keeps the log in order.
//
// 🦉 New in this file: your step 4 answer. You write `runTools`.

/**
 * The agent loop's pieces. `decide` reads the event log and says what happens next; `modelTurn` and `runTool` do
 * it and return the event to append. None of them knows how it's run: in a request, on a job queue or as a
 * Workflow, a runner loops decide, do, append.
 */
import { z } from "zod";

import type { AgentTool, NextAction, RunEvent, RunEventData, Screen, ToolCall, ToolContext } from "#learn/agent/types";
import type {
  ChatEvent,
  ChatMessage,
  ChatModel,
  ChatRequest,
  ReasoningEffort,
  ToolSpec,
  Usage,
} from "#learn/model/types";
import type { Viewer } from "#learn/retrieve/types";

import { type Caps, capReached, runUsage, turnEstimate } from "#learn/agent/caps";
import { PLAN_TOOL } from "#learn/agent/plan";
import { type Policy, planPolicy, type Verdict } from "#learn/agent/policy";

type AssistantTurn = Extract<RunEventData, { type: "assistant_turn" }>;
type ToolResult = Extract<RunEventData, { type: "tool_result" }>;

/** Retryable errors in a row (since the last model turn) before the run gives up. */
export const MAX_RETRIES = 3;

/** The statuses a run never leaves. */
export const FINAL = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

/**
 * Says, for one call, whether it runs, waits for the user or is refused. A boolean is the tools' own
 * `needsApproval` (true: wait for the user); a `Verdict` comes from a policy (`approvalNeeded` with one).
 */
export type Gate = (call: ToolCall, events: readonly RunEvent[]) => boolean | Verdict;

/** A call the policy refused: `runTool` answers it with the reason and runs nothing. */
export type DeniedCall = ToolCall & { denied: string };

const verdictOf = (answer: boolean | Verdict): Verdict =>
  typeof answer === "boolean" ? (answer ? { kind: "approve" } : { kind: "allow" }) : answer;

/**
 * What the loop does next, from the events alone. `needsApproval` says which calls run, wait for the user or are
 * refused (the policy, then the tools' own `needsApproval`, bound to the run by the runner). In order:
 * - a finished run, or nothing to answer yet: wait;
 * - a non-retryable error, or too many retryable ones: finish failed (`giveUp`);
 * - the last turn's calls (`pendingCalls`): the ones that can run go together first; then each one needing
 *   approval is asked for, one at a time; while an approval is open, wait;
 * - once every call is settled, or a user message is newer than the last turn: a model turn;
 * - a last turn with no calls and nothing newer: finish succeeded.
 * Before a model turn or a batch of calls, the caps are checked; a cap reached finishes the run failed.
 */
export function decide(events: readonly RunEvent[], caps: Caps, needsApproval: Gate): NextAction {
  const statuses = events.flatMap((e) => (e.data.type === "status" ? [e.data.to] : []));
  if (FINAL.has(statuses.at(-1) ?? "")) return { kind: "wait" };

  let lastTurn = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].data.type === "assistant_turn") {
      lastTurn = i;
      break;
    }
  }
  const since = events.slice(lastTurn + 1).map((e) => e.data);

  const stop = giveUp(since);
  if (stop) return stop;

  const usage = runUsage(events);
  const model = (): NextAction => {
    const reason = capReached(usage, caps);
    return reason ? { kind: "finish", status: "failed", reason } : { kind: "model" };
  };

  if (lastTurn === -1) return since.some((d) => d.type === "user_message") ? model() : { kind: "wait" };

  const turn = events[lastTurn].data as AssistantTurn;
  const { runnable, toAsk, waiting } = pendingCalls(turn, since, events, needsApproval);
  if (runnable.length) {
    const reason = capReached(usage, caps, runnable.length);
    return reason ? { kind: "finish", status: "failed", reason } : { kind: "tools", calls: runnable };
  }
  if (toAsk) return { kind: "approval", call: toAsk };
  if (waiting) return { kind: "wait" };
  if (turn.toolCalls.length || since.some((d) => d.type === "user_message")) return model();
  return { kind: "finish", status: "succeeded" };
}

/**
 * The error rule, from the events since the last model turn: a non-retryable error finishes the run failed, and so
 * does the `MAX_RETRIES`th retryable one. Null: carry on. (A tool's error never gets here: it's the call's result,
 * for the model to read.)
 */
export function giveUp(since: readonly RunEventData[]): NextAction | null {
  const errors = since.filter((d) => d.type === "error");
  const fatal = errors.find((d) => !d.retryable);
  if (fatal) return { kind: "finish", status: "failed", reason: fatal.message };
  if (errors.length >= MAX_RETRIES) {
    return {
      kind: "finish",
      status: "failed",
      reason: `gave up after ${errors.length} errors: ${errors.at(-1)!.message}`,
    };
  }
  return null;
}

/** Where a turn's unanswered calls stand. */
export interface PendingCalls {
  /** Calls that run now: reads, approved writes, and refused calls (marked, so `runTool` answers them). */
  runnable: ToolCall[];
  /** The first call that needs the user and hasn't been asked for yet. */
  toAsk?: ToolCall;
  /** A call is waiting on the user's decision. */
  waiting: boolean;
}

/**
 * Sorts the last turn's unanswered calls by `needsApproval`'s verdict. A refused call goes with the runnable ones,
 * marked `denied`. An allowed one runs. One that needs approval runs once approved, waits while asked, and is asked
 * for when it hasn't been. A rejected or expired one is settled already: whoever records that decision also appends
 * its `tool_result` (`declinedResult`), so the model sees why.
 */
export function pendingCalls(
  turn: AssistantTurn,
  since: readonly RunEventData[],
  events: readonly RunEvent[],
  needsApproval: Gate,
): PendingCalls {
  const answered = new Set(since.flatMap((d) => (d.type === "tool_result" ? [d.callId] : [])));
  const requested = new Map(
    since.flatMap((d) => (d.type === "approval_requested" ? [[d.call.callId, d.approvalId] as const] : [])),
  );
  const decided = new Map(
    since.flatMap((d) => (d.type === "approval_decided" ? [[d.approvalId, d.decision] as const] : [])),
  );

  const runnable: ToolCall[] = [];
  let toAsk: ToolCall | undefined;
  let waiting = false;
  for (const call of turn.toolCalls) {
    if (answered.has(call.callId)) continue;
    const verdict = verdictOf(needsApproval(call, events));
    if (verdict.kind === "deny") {
      const refused: DeniedCall = { ...call, denied: verdict.reason };
      runnable.push(refused);
      continue;
    }
    if (verdict.kind === "allow") {
      runnable.push(call);
      continue;
    }
    const approvalId = requested.get(call.callId);
    const decision = approvalId === undefined ? undefined : decided.get(approvalId);
    if (approvalId === undefined) toAsk ??= call;
    else if (decision === "approved") runnable.push(call);
    else if (decision === undefined) waiting = true;
  }
  return { runnable, toAsk, waiting };
}

/**
 * `decide`'s `needsApproval` for a run: the policy first, then the tool's own answer. A call to an unknown tool,
 * or with input its schema refuses, needs none: `runTool` answers it with an error and nothing runs, so there's
 * nothing to approve.
 *
 * The policy defaults to plan-then-execute (`planPolicy`) whenever the tools include `make_plan`, as the app's do.
 * `null` turns it off, as a tool set without the plan tool does.
 */
export function approvalNeeded(
  tools: readonly AgentTool[],
  viewer: Viewer,
  runId: string,
  policy: Policy | null = tools.some((t) => t.name === PLAN_TOOL) ? planPolicy : null,
): Gate {
  return (call, events) => {
    const parsed = parseCall(call, tools);
    if ("error" in parsed) return false;
    const verdict = policy?.check(call, { events, tool: parsed.tool }) ?? { kind: "allow" };
    if (verdict.kind !== "allow") return verdict;
    return parsed.tool.needsApproval(parsed.input, {
      viewer,
      runId,
      callId: call.callId,
      idempotencyKey: idempotencyKey(runId, call.callId),
      signal: new AbortController().signal,
    });
  };
}

/** The `tool_result` to append with a rejected or expired approval. */
export function declinedResult(callId: string, decision: "rejected" | "expired"): ToolResult {
  const error =
    decision === "rejected"
      ? "The user rejected this action. Don't retry it unless they ask."
      : "The approval expired before the user answered.";
  return { type: "tool_result", callId, ok: false, error };
}

/** The run must stop now: the kill switch is on or the user's daily budget is spent. Not for the model to see. */
export class RunHalted extends Error {
  override name = "RunHalted";

  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Tokens of the user's daily budget held for one model call (`#learn/agent/budget`), settled after it. */
export interface TokenHold {
  id: string;
  day: string;
  tokens: number;
}

/** Checks outside the run's own caps, which need the database (`#learn/agent/budget`). Each throws `RunHalted`. */
export interface RunGuard {
  /** The kill switch, then a hold on `estimate` tokens of the user's day, taken in one statement (refused when
   * they aren't left). No estimate holds one token: a plain check. */
  beforeModelTurn(estimate?: number): Promise<TokenHold | void>;
  /** Settles the hold to what the call used. `null` (the call failed) gives the hold back. */
  afterModelTurn(usage: Usage | null, hold?: TokenHold | void): Promise<void>;
  beforeToolCall(): Promise<void>;
  /** The guardrails (`#learn/agent/guardrails`): checks each write the model proposes, before anyone approves it.
   * One `Screen` per call, in order. */
  screen?(calls: readonly ToolCall[], signal?: AbortSignal): Promise<Screen[]>;
}

/** A tool's input as JSON Schema, for the model. */
export function toolSpecs(tools: readonly AgentTool[]): ToolSpec[] {
  return tools.map((tool) => {
    const { $schema: _, ...inputSchema } = z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown>;
    return { name: tool.name, description: tool.description, inputSchema };
  });
}

export interface ModelTurnDeps {
  model: ChatModel;
  tools: readonly AgentTool[];
  reasoningEffort: ReasoningEffort;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  guard?: RunGuard;
  /** Text as it streams, for a live view. The event holds all of it. */
  onTextDelta?: (delta: string) => void;
}

/** What a model turn sees. `planning` is what the planning turn sees instead (`#learn/agent/context` builds it). */
export interface TurnContext {
  instructions: string;
  messages: ChatMessage[];
  planning?: { instructions: string; messages: ChatMessage[] };
}

const isSummary = (message: ChatMessage) =>
  message.role === "user" && typeof message.content === "string" && message.content.startsWith("<summary>");

/**
 * The planning turn: the agent has the plan tool and the newest message is the user's (a summary of compacted
 * events doesn't count). Then the model must call `make_plan` before anything else.
 */
function isPlanningTurn(context: TurnContext, tools: readonly AgentTool[]): boolean {
  const last = context.messages.at(-1);
  return tools.some((t) => t.name === PLAN_TOOL) && last?.role === "user" && !isSummary(last);
}

/**
 * What the planning turn sees: the user's own messages, nothing else. No tool output, no earlier answer, no
 * memory note and no summary (which retells tool output) can put a write in the plan. `buildContext` gives it
 * with its instructions; without it, the user's messages are picked out of the context.
 */
export function planningInput(context: TurnContext): { instructions: string; messages: ChatMessage[] } {
  return (
    context.planning ?? {
      instructions: context.instructions,
      messages: context.messages.filter((m) => m.role === "user" && !isSummary(m)),
    }
  );
}

/**
 * One model call: the context in, an `assistant_turn` out (its text, its tool calls and what it cost). On the
 * planning turn it sees only the user's messages and must call `make_plan`. The write calls it proposes go through
 * the guard's guardrails, and what they find is recorded on the call, so `decide`'s policy can read it from the
 * events.
 */
export async function modelTurn(context: TurnContext, deps: ModelTurnDeps): Promise<AssistantTurn> {
  const planning = isPlanningTurn(context, deps.tools);
  const { instructions, messages } = planning ? planningInput(context) : context;
  const request: ChatRequest = {
    instructions,
    messages,
    tools: toolSpecs(deps.tools),
    ...(planning ? { toolChoice: { tool: PLAN_TOOL } } : {}),
    reasoningEffort: deps.reasoningEffort,
    maxOutputTokens: deps.maxOutputTokens,
    abortSignal: deps.signal,
  };
  const hold = await deps.guard?.beforeModelTurn(turnEstimate(request));
  let turn: AssistantTurn;
  try {
    turn = await readTurn(deps.model.stream(request), deps.onTextDelta);
  } catch (error) {
    // The call failed or was aborted: give the hold back.
    await deps.guard?.afterModelTurn(null, hold).catch(() => {});
    throw error;
  }
  await deps.guard?.afterModelTurn(turn.usage, hold);
  const writes = turn.toolCalls.filter((c) => deps.tools.find((t) => t.name === c.tool)?.effect === "write");
  if (writes.length > 0 && deps.guard?.screen) {
    const screens = await deps.guard.screen(writes, deps.signal);
    writes.forEach((call, i) => (call.screen = screens[i]));
  }
  return turn;
}

/**
 * Reads one model call's stream into its `assistant_turn`: the text deltas joined (each one also handed to
 * `onTextDelta` as it comes), each tool call whole, as its own `ToolCall` with the model's call id, and the usage
 * the finish carries. A stream that ends without a finish throws: the turn is incomplete.
 */
export async function readTurn(
  stream: AsyncIterable<ChatEvent>,
  onTextDelta?: (delta: string) => void,
): Promise<AssistantTurn> {
  let text = "";
  const toolCalls: ToolCall[] = [];
  let usage: Usage | undefined;
  for await (const event of stream) {
    if (event.type === "text-delta") {
      text += event.delta;
      onTextDelta?.(event.delta);
    } else if (event.type === "tool-call") {
      toolCalls.push({ callId: event.callId, tool: event.name, input: event.input });
    } else {
      usage = event.usage;
    }
  }
  if (!usage) throw new Error("the model's stream ended without a finish");
  return { type: "assistant_turn", text, toolCalls, usage };
}

export interface RunToolDeps {
  tools: readonly AgentTool[];
  viewer: Viewer;
  runId: string;
  /** The run's signal: cancelling the run aborts its tools. */
  signal?: AbortSignal;
  /** Per call. */
  timeoutMs?: number;
  guard?: RunGuard;
}

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** Stable for a call across retries and restarts, so a write repeated with it happens once. */
export const idempotencyKey = (runId: string, callId: string) => `agent:${runId}:${callId}`;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * One tool call, as the viewer. A call the policy refused, an unknown tool, input that fails the tool's schema, a
 * thrown error or a timeout becomes an `ok: false` result for the model to read and recover from. Only `RunHalted`
 * is thrown.
 */
export async function runTool(call: ToolCall, deps: RunToolDeps): Promise<ToolResult> {
  const { denied } = call as Partial<DeniedCall>;
  if (denied) return failed(call, denied);
  await deps.guard?.beforeToolCall();
  const parsed = parseCall(call, deps.tools);
  if ("error" in parsed) return failed(call, parsed.error);
  return executeCall(call, parsed.tool, parsed.input, deps);
}

const failed = (call: ToolCall, error: string): ToolResult => ({
  type: "tool_result",
  callId: call.callId,
  ok: false,
  error,
});

/**
 * Finds the call's tool in the registry and checks the model's input against the tool's zod schema: the tool and
 * the parsed input, or the error the model should read (which tool doesn't exist, which field is wrong).
 */
export function parseCall(
  call: ToolCall,
  tools: readonly AgentTool[],
): { tool: AgentTool; input: unknown } | { error: string } {
  const tool = tools.find((t) => t.name === call.tool);
  if (!tool) return { error: `There is no tool called ${call.tool}.` };
  const parsed = tool.input.safeParse(call.input);
  if (!parsed.success) return { error: `Invalid input: ${z.prettifyError(parsed.error)}` };
  return { tool, input: parsed.data };
}

/**
 * Runs a checked call as the viewer, within `timeoutMs`. Its output, or what went wrong, becomes the call's
 * `tool_result`: a thrown error or a timeout is `ok: false` with a message the model can read. Only `RunHalted`
 * (the kill switch, the budget) and the run's own abort are thrown, since those stop the run, not the call.
 */
export async function executeCall(
  call: ToolCall,
  tool: AgentTool,
  input: unknown,
  deps: RunToolDeps,
): Promise<ToolResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  const ctx: ToolContext = {
    viewer: deps.viewer,
    runId: deps.runId,
    callId: call.callId,
    idempotencyKey: idempotencyKey(deps.runId, call.callId),
    signal,
  };
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // A tool that ignores its signal still can't hold the loop past the timeout.
    const output = await Promise.race([tool.execute(input, ctx), aborted]);
    return { type: "tool_result", callId: call.callId, ok: true, output: output ?? null };
  } catch (error) {
    if (error instanceof RunHalted) throw error;
    if (timeout.aborted) return failed(call, `${call.tool} timed out after ${timeoutMs / 1000} s.`);
    if (deps.signal?.aborted) throw deps.signal.reason;
    return failed(call, message(error));
  } finally {
    signal.removeEventListener("abort", onAbort);
    aborted.catch(() => {});
  }
}

/** A turn's calls, run in parallel; the results come back in call order, whatever order they finish in. */
export async function runTools(calls: readonly ToolCall[], deps: RunToolDeps): Promise<ToolResult[]> {
  // 🐨 Start every call at once, each through `runTool(call, deps)`, and wait until all of them have settled.
  // 🐨 Return the results in the order of `calls`, the order the model asked for them, whatever order they finish
  //    in.
  // 🐨 `runTool` throws only to stop the run (`RunHalted`, a cancel). If a call threw, throw that, once they've all
  //    settled.
  // 🐨 The classic mistake: collecting each result as it arrives. That's the order the network picked.
  //
  // 💰 `Promise.allSettled(promises)` keeps the promises' order; each entry is `{ status: "fulfilled", value }` or
  //    `{ status: "rejected", reason }`.
  //
  // 🦉 Why call order. OpenAI pairs a result with its call by id, so the model would cope with any order. It's the
  //    log that needs it. The log is the run's state (step 1), and a log that depends on which request won a race
  //    can't be reproduced: replay the same run and Tom's lookup lands at seq 5 one time and seq 6 the next.
  //    Section 15's Workflow replays runs from their recorded steps and needs the same log every time.
  // 🦉 Why let every call settle before throwing. A call that's still running when you throw keeps going, and a
  //    mail can still leave. Waiting for all of them means that when the run is marked failed, nothing it started
  //    is still running.
  // 🦉 Why together. A turn's calls don't depend on each other: the model asked for them in one breath, before
  //    seeing any result. So the turn takes as long as its slowest call. Grace's took 5.1 s; one after the other
  //    would add the lookup's 7 ms, and with three searches it would be three times as long.
  //
  // 🚨 The tests check two calls run together, results in call order whatever finishes first, a failing call
  //    beside a working one, a run stopped by `RunHalted`, and Grace's turn: the lookup done 5.1 s before the
  //    search, logged after it.
  throw new Error(`runTools(${calls.length} calls, run ${deps.runId}) isn't written yet`);
}
