# M2 contract (reference agents)

The shared agreements for M2's lanes. `PLAN.md` says why; `docs/m0-contract.md` and `docs/m1-contract.md` still hold for everything they set up (env via `acEnv()`, the `#learn` slots, RLS through `withTenant`, `getViewer` and the viewer middleware, `ChatModel`, `retrieve`, `canRead`, the outbox and relay). If a lane has to break this contract, it says so in its report instead of silently diverging.

**M2 is done when** a run survives a killed dev server mid-tool-call with its side effect happening once, an approval resumes a paused run, and the poisoned partner pack can't get the Heron memo sent anywhere. M2 runs in waves of at most two agents.

| Wave | Lanes |
|---|---|
| 1 | A. The loop and tools (section 13). B. State (section 14) |
| 2 | C. Durability (section 15, plus section 05's hand-built job queue, which M1 skipped). D. Safety and the agent UI (section 17, section 12's run timeline and approval inbox) |
| 3 | E. Orchestration (section 16). F. Integration, smoke checks, live scenarios |

Decisions Lucien made for M2:
- **Write tools:** `send_mail` and `share_document`, served by fake-workspace with an `Idempotency-Key`.
- **Approvals:** the acting user approves their own run's write actions. The allowlist can still refuse an action outright.
- **Memory:** compaction, plus short per-user notes written by a `remember` tool and loaded when a run starts.
- **Where runs live:** one chat. A router (section 16) sends a message either to a plain answer or to an agent run. The run timeline and approvals show inline, and an inbox page lists pending approvals.

## The rule for code layout

Same as M1. Everything a later exercise asks the learner to write lives in `src/core/<area>/<module>.ts`, imported as `#learn/<area>/<module>`, and takes its dependencies as arguments. Glue (routes, workflows, DB writes, wiring) lives outside `src/core`.

**One loop, several runners.** The agent's logic doesn't know how it's run. A pure `decide(events)` says what happens next, and the pieces that do it (a model turn, a tool call) take what they need as arguments. Three runners drive the same pieces:
1. in-request, in a server route (sections 13 and 14);
2. on the hand-built job queue, with checkpoints (section 15.1);
3. as a Vercel Workflow (section 15.3 on). **The app uses this one.**

Every runner appends to the same event log, so the learner can swap a runner without touching the loop.

## Wave 1 ownership

| Lane | Owns |
|---|---|
| A. Loop + tools | `src/core/agent/{loop,tools,caps,budget}*.ts`, `src/core/agent/tools/**`, `src/core/model/**` (the tool-calling extension, both clients), `servers/fake-workspace/**` (mail and sharing), `src/lib/agent-tools.ts` (wiring the tools to the app), their tests |
| B. State | `src/core/agent/{types,state,events,context,compact,memory}*.ts`, `src/db/**` (every M2 migration in this wave, A's tables included), `src/lib/agent-runs.ts` (the run service), `src/routes/api/runs/**` (the in-request runner and the event-log stream), their tests |

Shared files (`package.json`, `.env.example`, `vitest.config.ts`, the "Settled during the build" section below): re-read right before writing, change only your lines. **Lane A owns the live stack** (Docker, :3000, :8100); lane B runs database tests only, which can run alongside. Neither lane stops Docker or OrbStack. No nested subagents.

## Shared types (lane B writes `src/core/agent/types.ts` first, then tells lane A)

```ts
import type { Usage } from "#learn/model/types";
import type { Viewer } from "#learn/retrieve/types";

export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "timed_out";
// queued -> running | cancelled
// running -> waiting | succeeded | failed | cancelled | timed_out
// waiting -> running | cancelled | timed_out      (an expired approval resumes the run with "expired")
// succeeded, failed, cancelled, timed_out are final

export interface ToolCall { callId: string; tool: string; input: unknown }

export type RunEventData =
  | { type: "user_message"; messageId: string; text: string }
  | { type: "assistant_turn"; text: string; toolCalls: ToolCall[]; usage: Usage }
  | { type: "tool_result"; callId: string; ok: true; output: unknown }
  | { type: "tool_result"; callId: string; ok: false; error: string }
  | { type: "approval_requested"; approvalId: string; call: ToolCall; expiresAt: string }
  | { type: "approval_decided"; approvalId: string; decision: "approved" | "rejected" | "expired"; by: string | null }
  | { type: "status"; from: RunStatus; to: RunStatus; reason?: string }
  | { type: "compaction"; throughSeq: number; summary: string }
  | { type: "error"; message: string; retryable: boolean };

export interface RunEvent { runId: string; seq: number; at: string; data: RunEventData }

/** What the loop does next, decided from the events alone. */
export type NextAction =
  | { kind: "model" }
  | { kind: "tools"; calls: ToolCall[] }          // read tools, or approved write tools
  | { kind: "approval"; call: ToolCall }          // a write tool waiting on its user
  | { kind: "wait" }                              // nothing to do until a message or a decision arrives
  | { kind: "finish"; status: "succeeded" | "failed" | "timed_out"; reason?: string };

export interface ToolContext {
  viewer: Viewer;
  runId: string;
  callId: string;
  /** Stable across retries of this call: derived from the run and the call, never random. */
  idempotencyKey: string;
  signal: AbortSignal;
}
```

The tool interface goes in the same file, so lane B's `remember` tool doesn't wait on lane A (`z` from `zod`):

```ts
export interface AgentTool<I = unknown, O = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  effect: "read" | "write";
  /** Write tools say true. A policy (section 17) can still refuse the call before this is asked. */
  needsApproval(input: I, ctx: ToolContext): boolean;
  execute(input: I, ctx: ToolContext): Promise<O>;
}
```

## Lane A: the loop and tools (section 13)

- **The model extension.** `ChatRequest` gains `tools?: ToolSpec[]` (name, description, JSON schema) and `toolChoice?`. `ChatMessage` gains an assistant turn with tool calls and a tool output message. `ChatEvent` gains a complete `tool-call` event; argument deltas stay inside the client. Both `responsesChatModel` and `aiSdkChatModel` implement it, and M1's tests stay green. The Responses client sends `store: false`, so each request carries the whole context: function calls go back as `function_call` items, and their results as `function_call_output`.
- **The loop** (`#learn/agent/loop`):
  - `decide(events, caps)` returns a `NextAction`. It is pure.
  - `modelTurn(context, deps)` returns an `assistant_turn`.
  - `runTool(call, deps)` returns a `tool_result`. It validates input with zod, and a validation error, a thrown error or a timeout goes back to the model as `ok: false`, not up the stack.
  - Calls in one turn run in parallel (`Promise.allSettled`), and their results are appended in call order.
- **Caps and budgets** (`#learn/agent/caps`, `#learn/agent/budget`):
  - Per-run caps: model turns (default 12), tool calls (30), tokens (60,000), and active wall-clock time. Waiting doesn't count toward that time.
  - A per-user daily token budget in Postgres (default 500,000), on the rate-limit pattern: checked before each model turn, charged after it.
  - A kill switch, per tenant in Postgres plus `AGENT_KILL_SWITCH=1` for everyone, checked before every model turn and every tool call. A run that hits a cap or the switch finishes `failed` with the reason.
- **Tools** (`src/core/agent/tools/*`). Each acts as the viewer:
  - **Read tools:**
    - `search_documents` (`retrieve`, k ≤ 8; returns chunk ids, titles, paths, pages and text);
    - `read_document` (`canRead` first; returns its chunks in order, capped in tokens);
    - `find_person` (the tenant's directory principals by name or email; no disabled users).
  - **Write tools:**
    - `send_mail` (to, subject, body, optional document ids as attachments);
    - `share_document` (document id, recipient user or group, role `read`).

  Both write tools check `canRead` for every document they touch before anything leaves, and pass `ctx.idempotencyKey` as the `Idempotency-Key` header.
- **fake-workspace:**
  - **Mail:** `POST /v1.0/users/{id}/sendMail` (Graph's shape; 202).
  - **Sharing:** `POST /v1.0/drives/{drive}/items/{item}/invite` (Graph's shape). It changes the item's permissions and sends the change notification, so ACL sync picks it up. That's a loop the course can show end to end.
  - **Idempotency:** both endpoints honour `Idempotency-Key`. The same key with the same body returns the first response and does nothing. The same key with a different body gets a 422.
  - **Second line of defence:** mail refuses an attachment the sender can't read.
  - **Sent mail** is listed by `GET /_control/mail`, which tests and the smoke checks use to count sends. Faults (429, 5xx, a slow response) are injectable, as for the drive.
- **Tests:** the AI SDK's mock model as the scripted fake. Cover:
  - a tool error fed back and recovered from;
  - parallel calls appended in order;
  - each cap tripping;
  - the kill switch;
  - a write tool with an unreadable attachment refused;
  - the same `Idempotency-Key` sending once.

  Live proof (needs the key): one in-request run as `leo.martin` that searches, reads and drafts a mail, stopping at the approval.

## Lane B: state (section 14)

- **Schema** (RLS forced, like every tenant table):
  - **`runs`:** `id, tenant_id, user_id, conversation_id, parent_run_id, kind (chat|automation|subagent), status, version, workflow_run_id, caps jsonb, active_ms, created_at, updated_at, finished_at`.
  - **`run_events`:** `run_id, seq, at, type, data jsonb, step_key`, unique `(run_id, seq)` and `(run_id, step_key)`. `step_key` is null for events written outside Workflow.
  - **`approvals`:** `id, tenant_id, run_id, call_id, tool, input jsonb, status (pending|approved|rejected|expired), decided_by, decided_at, expires_at`.
  - **`memory_notes`:** `id, tenant_id, user_id, text, source_run_id, created_at`.
  - **Lane A's tables:** `agent_budgets` (per user per day) and `agent_switches` (per tenant).
- **The run service** (`src/lib/agent-runs.ts`):
  - **Appending:** `append(tx, runId, expectedVersion, events)` takes `seq = max + 1` and bumps `runs.version` in the same statement. A stale version throws a conflict error, so the caller re-reads and retries. Status changes go through the state machine (`#learn/agent/state`); an illegal transition throws.
  - **Messages:** a message into a live run carries the client's id as its idempotency key, so a resend stores nothing twice. Two messages arriving at once both land, in `seq` order.
- **Context** (`#learn/agent/context`): `buildContext(events, budget)` folds the events into `ChatMessage[]`. It starts from the latest `compaction` and includes the user's memory notes and the tool results, within a token budget.
- **Compaction** (`#learn/agent/compact`): past a threshold, the model summarises the events up to a `seq`, and a `compaction` event records it. The summary keeps open approvals, ids and decisions.
- **Memory** (`#learn/agent/memory`): the `remember` tool (lane B writes it, against lane A's `AgentTool`) stores a short note. Notes are capped in count and length, loaded at run start, and listed and deletable by their user.
- **The in-request runner and streaming:**
  - `POST /api/runs` starts a run, and `POST /api/runs/:id/messages` adds a message. The in-request runner loops `decide`, then does the work, then appends.
  - `GET /api/runs/:id/stream` sends SSE, with `id:` set to the event's `seq`. It resumes from `Last-Event-ID` by tailing `run_events`, with heartbeats as in M1.

  These routes go through the viewer middleware. Another user's run, or another tenant's, answers 404.
- **Tests:** a stale-version conflict; two concurrent appends both landing in order; a resent message stored once; context rebuilt identically after compaction; a stream resumed from a `seq`.

## Wave 2 (C, D) and wave 3 (E, F): scope, detailed in this file before each wave starts

- **C. Durability:**
  - A Postgres job queue by hand: `FOR UPDATE SKIP LOCKED`, leases, attempts, a dead-letter state.
  - A runner on it that checkpoints after every event and resumes after a kill.
  - Idempotent side effects keyed on the step.
  - The run as a Workflow:
    - model turns and tool calls are steps, and events are written with a `step_key` taken from the `stepId`;
    - tokens go through `getWritable()`;
    - approvals are hooks with a 7-day timeout;
    - cancellation aborts a live model call;
    - notes on determinism and on changing code under open runs.
  - The kill-the-server proof.
- **D. Safety and UI:**
  - Tools run as the acting user, checked again in Postgres.
  - Plan-then-execute: a planned set of actions, an allowlist (internal recipients only; sharing only within the tenant), and any call outside the plan refused.
  - Guardrails at the server boundary.
  - A red-team runner, with the poisoned partner pack first.
  - The run timeline inline in the chat, the approval inbox, and a stream that reconnects.
- **E. Orchestration:**
  - Routing between a plain answer and an agent run.
  - An orchestrator with sub-agents as child workflows.
  - Automations on schedules and drive-change triggers, run by a dev-only scheduler (the Vercel cron is section 22).
  - Fan-out with a concurrency limit.
  - The same agent on `WorkflowAgent`, for comparison.
- **F. Integration:**
  - New `ex smoke` checks:
    - "agent": kill mid-tool-call, the mail is sent once;
    - "approval": approve, the run resumes;
    - "red-team": the Heron memo never leaves.
  - Live scenarios on gpt-6-luna.

## Settled during the build

(Lanes add what they decided here: one bullet per decision, plain words.)
