/**
 * The agent loop's pieces. `decide` reads the event log and says what happens next; `modelTurn` and `runTool` do
 * it and return the event to append. None of them knows how it's run: in a request, on a job queue or as a
 * Workflow, a runner loops decide, do, append.
 */
import { z } from "zod";

import type { ChatMessage, ChatModel, ReasoningEffort, ToolSpec, Usage } from "#learn/model/types";
import type { Viewer } from "#learn/retrieve/types";

import type { AgentTool, NextAction, RunEvent, RunEventData, Screen, ToolCall, ToolContext } from "./types";

import { type Caps, capReached, runUsage } from "./caps";
import { PLAN_TOOL } from "./plan";
import { type Policy, planPolicy, type Verdict } from "./policy";

type AssistantTurn = Extract<RunEventData, { type: "assistant_turn" }>;
type ToolResult = Extract<RunEventData, { type: "tool_result" }>;

/** Retryable errors in a row (since the last model turn) before the run gives up. */
export const MAX_RETRIES = 3;

const FINAL = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

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
 * - a non-retryable error, or too many retryable ones: finish failed;
 * - a call the policy refuses goes with the runnable calls, marked, so `runTool` answers it with the reason;
 * - the last turn's calls: the approved ones and the ones needing none run together first; then each one needing
 *   approval is asked for, one at a time; while an approval is open, wait;
 * - a rejected or expired call is settled: whoever records that decision also appends its `tool_result`
 *   (`declinedResult`), so the model sees why;
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

  const usage = runUsage(events);
  const model = (): NextAction => {
    const reason = capReached(usage, caps);
    return reason ? { kind: "finish", status: "failed", reason } : { kind: "model" };
  };

  if (lastTurn === -1) return since.some((d) => d.type === "user_message") ? model() : { kind: "wait" };

  const turn = events[lastTurn].data as AssistantTurn;
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
    const tool = tools.find((t) => t.name === call.tool);
    const parsed = tool?.input.safeParse(call.input);
    if (!tool || !parsed?.success) return false;
    const verdict = policy?.check(call, { events, tool }) ?? { kind: "allow" };
    if (verdict.kind !== "allow") return verdict;
    return tool.needsApproval(parsed.data, {
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

/** Checks outside the run's own caps, which need the database (`#learn/agent/budget`). Each throws `RunHalted`. */
export interface RunGuard {
  beforeModelTurn(): Promise<void>;
  afterModelTurn(usage: Usage): Promise<void>;
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

/**
 * The planning turn: the agent has the plan tool and the newest message is the user's (a summary of compacted
 * events doesn't count). Then the model must call `make_plan` before anything else.
 */
function planningTurn(context: { messages: ChatMessage[] }, tools: readonly AgentTool[]): boolean {
  const last = context.messages.at(-1);
  return (
    tools.some((t) => t.name === PLAN_TOOL) &&
    last?.role === "user" &&
    !(typeof last.content === "string" && last.content.startsWith("<summary>"))
  );
}

/**
 * One model call: the context in, an `assistant_turn` out (its text, its tool calls and what it cost). The write
 * calls it proposes go through the guard's guardrails, and what they find is recorded on the call, so `decide`'s
 * policy can read it from the events.
 */
export async function modelTurn(
  context: { instructions: string; messages: ChatMessage[] },
  deps: ModelTurnDeps,
): Promise<AssistantTurn> {
  await deps.guard?.beforeModelTurn();
  let text = "";
  const toolCalls: ToolCall[] = [];
  let usage: Usage | undefined;
  for await (const event of deps.model.stream({
    instructions: context.instructions,
    messages: context.messages,
    tools: toolSpecs(deps.tools),
    ...(planningTurn(context, deps.tools) ? { toolChoice: { tool: PLAN_TOOL } } : {}),
    reasoningEffort: deps.reasoningEffort,
    maxOutputTokens: deps.maxOutputTokens,
    abortSignal: deps.signal,
  })) {
    if (event.type === "text-delta") {
      text += event.delta;
      deps.onTextDelta?.(event.delta);
    } else if (event.type === "tool-call") {
      toolCalls.push({ callId: event.callId, tool: event.name, input: event.input });
    } else {
      usage = event.usage;
    }
  }
  if (!usage) throw new Error("the model's stream ended without a finish");
  await deps.guard?.afterModelTurn(usage);
  const writes = toolCalls.filter((c) => deps.tools.find((t) => t.name === c.tool)?.effect === "write");
  if (writes.length > 0 && deps.guard?.screen) {
    const screens = await deps.guard.screen(writes, deps.signal);
    writes.forEach((call, i) => (call.screen = screens[i]));
  }
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
  const fail = (error: string): ToolResult => ({ type: "tool_result", callId: call.callId, ok: false, error });
  const { denied } = call as Partial<DeniedCall>;
  if (denied) return fail(denied);
  await deps.guard?.beforeToolCall();
  const tool = deps.tools.find((t) => t.name === call.tool);
  if (!tool) return fail(`There is no tool called ${call.tool}.`);
  const parsed = tool.input.safeParse(call.input);
  if (!parsed.success) return fail(`Invalid input: ${z.prettifyError(parsed.error)}`);

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
    const output = await Promise.race([tool.execute(parsed.data, ctx), aborted]);
    return { type: "tool_result", callId: call.callId, ok: true, output: output ?? null };
  } catch (error) {
    if (error instanceof RunHalted) throw error;
    if (timeout.aborted) return fail(`${call.tool} timed out after ${timeoutMs / 1000} s.`);
    if (deps.signal?.aborted) throw deps.signal.reason;
    return fail(message(error));
  } finally {
    signal.removeEventListener("abort", onAbort);
    aborted.catch(() => {});
  }
}

/** A turn's calls, run in parallel; the results come back in call order, whatever order they finish in. */
export async function runTools(calls: readonly ToolCall[], deps: RunToolDeps): Promise<ToolResult[]> {
  const settled = await Promise.allSettled(calls.map((call) => runTool(call, deps)));
  return settled.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}
