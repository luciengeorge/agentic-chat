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

**Lane B (state)**

- **Types.** `src/core/agent/types.ts` is the contract's block as written; nothing changed after lane A started.
- **Schema** (migration `20261014115355_m2_state`, declared in the Drizzle schema, RLS forced, `ac_app` granted by default privileges and by an explicit GRANT). Each table carries `tenant_id` for the policy, `run_events` included, and points at its parent through `(tenant_id, id)` so no row can point into another tenant. `runs`: `version` starts at 0 and counts appends; `caps` is a jsonb object over lane A's `DEFAULT_CAPS`; `active_ms` is time the runner spent working. A conversation or parent run deleted takes its runs with it. `run_events`: primary key `(run_id, seq)`, `seq` from 1 with no gaps, unique `(run_id, step_key)`, `type` must equal `data->>'type'`, and a partial unique index on `(run_id, data->>'messageId')` for user messages. `approvals`: unique `(run_id, call_id)`, `decided_at` set exactly when the status isn't `pending`, `decided_by` null for an expiry. `memory_notes`: 1 to 500 characters in the database (the app caps at 280); `source_run_id` has no foreign key, so a note outlives its run. `agent_budgets(tenant_id, user_id, day, tokens_used, token_limit, updated_at)`, keyed by all three; `agent_switches(tenant_id, enabled, reason, updated_by, updated_at)`, no row meaning enabled.
- **Append** is `append(tx, runId, expectedVersion, events, { stepKey?, activeMs? })` in `#learn/agent/events`, re-exported by `src/lib/agent-runs.ts`. It reads the run, checks the version (else `VersionConflictError` with the actual version) and runs the batch's status events through `#learn/agent/state` (else `IllegalTransitionError`). Then one statement updates `runs` `WHERE version = expected AND status = read status` and inserts the events at `max(seq) + 1` onwards from that update's CTE: a writer that lost the race updates nothing, so it inserts nothing. A final status sets `finished_at`. With a `stepKey`, event i gets `step_key = <stepKey>:<i>`.
- **The state machine** (`#learn/agent/state`): a `status` event's `from` must be the run's status. After a final status, more status moves are refused, but other events can still be appended (a tool result that was in flight when the run was cancelled).
- **Messages.** `addMessage(db, viewer, runId, { messageId, text })` answers `added` or `duplicate` (with the seq), `finished` or `not-found`. A writer that loses the version race re-reads in the same transaction and appends after the winner (up to 20 times); two sends of the same id at once end with one row (the loser sees the first, or hits the unique index and retries). `startRun` takes the client's run id, so a retried `POST /api/runs` makes one run, and someone else's run id answers 404.
- **Context.** `buildContext(events, budget = 24_000, { notes, instructions })` returns `{ instructions, messages }` (lane A's `modelTurn` takes that shape). Notes go after the instructions, introduced as facts and not instructions. A compaction's summary is the first message, a user turn in a `<summary>` tag. A turn and its calls' results are kept or dropped together, oldest first, and the newest turn always stays. A tool result whose call isn't in the replayed events is left out. A refused or expired write with no `tool_result` gets an error message for the model; lane A's convention (`declinedResult` appended with the decision) makes that a fallback.
- **Compaction** (`#learn/agent/compact`): past 16,000 tokens of live events, `compact` cuts at the latest point where every call is answered (by a result, or a refusal or expiry) that leaves at least 4,000 tokens after it, so an open approval is never cut past. The model (low effort) summarises from the previous summary plus the covered events. Code then appends `keptFacts`: open approvals, every decision, every call id with its tool, input and outcome, and the user message ids. The runner checks it before every model turn; summarising tokens aren't charged to the budget yet.
- **Memory.** `remember` has `effect: "write"` but `needsApproval` false: it writes only the user's own notes, which they can list (`GET /api/memory`) and delete (`DELETE /api/memory/:id`, 404 for someone else's). At most 20 notes per user (a full memory refuses the note: older notes are never pushed out by a newer one, which an injected document might try), 280 characters each, whitespace squashed, a case-insensitive duplicate stores nothing. An advisory lock per user keeps the count under the cap.
- **The in-request runner** is `driveRun(deps, viewer, runId, signal)` with a `RunnerLoop` (`decide`, `modelTurn`, `runTools`, `compact`); `createRunnerLoop(viewer, settings)` binds lane A's real `#learn/agent/loop` to the tools, model, guard and the run's caps. Claiming the run is the `queued`/`waiting` to `running` move; a runner that finds the run `running` returns `busy`. A model turn that loses the version race is thrown away and decided again (it missed what got in first); tool results are appended anyway, skipping any call already recorded. An approval inserts the `approvals` row (7 days) and appends `approval_requested` plus `running -> waiting` in one transaction. Anything thrown (`RunHalted` included) appends a non-retryable `error` and `running -> failed` with the message as the reason. It isn't durable: a killed server leaves the run `running`, which wave 2's runners resume.
- **Routes.** `POST /api/runs` takes `{ id, conversationId?, message: { id, text } }` (64 KB, 4,000 characters, a conversation of the viewer's), rate-limits on an `agent` bucket (5, then one every 30 s; 403 `not_in_directory` as in chat), and answers 202 `{ id, seq, duplicate }`. It starts the runner in the server process without waiting for it, whenever the run is `queued` or `waiting`. `POST /api/runs/:id/messages` does the same for a message; a finished run answers 409 `run_finished`. Both answer 404 for another user's run, another tenant's, or an id that isn't a uuid.
- **The stream.** `GET /api/runs/:id/stream` polls `run_events` every 250 ms in a tenant transaction (status first, then events after the cursor, 500 at a time), sends each as `id: <seq>` with the `RunEvent` as JSON `data`, and ends once the run is final and everything is sent. It starts after `Last-Event-ID`, else `?after=`, else from the top, and reuses chat's 15 s heartbeat comments. It polls rather than LISTEN, so it needs nothing from the runner that wrote the events.

**Lane A (loop and tools)**

- **The model extension** (`#learn/model/types`). `ChatMessage` is a union: a user turn, an assistant turn with optional `toolCalls: ChatToolCall[]` (`{ callId, name, input }`), and `{ role: "tool", callId, toolName, output, isError? }`. `ToolSpec` is `{ name, description, inputSchema }` (JSON Schema); `ToolChoice` is `"auto" | "none" | "required" | { tool }`. `ChatEvent` gains `{ type: "tool-call", callId, name, input }`, whole. Arguments that aren't JSON come through as the raw string, so the loop answers them with a validation error. The RAG answer's history uses the new `TextMessage` (user or assistant text), so `src/core/generate/{prompt,answer}.ts` and `src/routes/api/chat/-store.ts` changed their type names only, and `answer` now reads the finish with `else if`.
- **Both clients.** The AI SDK one turns tools into `jsonSchema` tools with no `execute`, so `streamText` reports the calls and stops; results go back as `tool-result` parts (`json`, or `error-text` for an error). The Responses one sends `store: false`, calls as `function_call` items and results as `function_call_output` strings (an error as `{"error": ...}`), and `tool_choice` when set.
- **Tool inputs are strict-mode safe.** OpenAI's strict mode wants every property required, so an optional input is `.nullable()` (`k: null` means the default), never `.optional()` or `.default()`. `toolSpecs` converts with `z.toJSONSchema(..., { io: "input" })`. Checked live: gpt-6-luna accepted all five.
- **`decide(events, caps, needsApproval)`.** It takes a third argument: which calls wait for the user. `approvalNeeded(tools, viewer, runId)` builds it from the tools' own `needsApproval`; a call to an unknown tool, or with input the schema refuses, needs no approval, because `runTool` answers it with an error and nothing runs. In one turn, the runnable calls (reads and approved writes) go first, together; then each write is asked for, one at a time. A rejected or expired approval settles its call: whoever appends `approval_decided` also appends `declinedResult(callId, decision)`. Three retryable `error` events since the last model turn, or one non-retryable, finish the run `failed`. A finished run decides `wait`.
- **Caps** (`#learn/agent/caps`): `DEFAULT_CAPS` is 12 model turns, 30 tool calls, 60,000 tokens (input plus output), 10 minutes active. `runUsage(events)` counts them from the events alone; active time adds the spans whose status is `running`, up to the latest event (a log with no status yet counts from its first event). Tool calls count results. A cap is checked before a model turn, and before a batch of calls that would pass it. Every cap, the time one included, finishes `failed` with `cap reached: ...` as the reason.
- **Guard** (`#learn/agent/budget`). `RunGuard { beforeModelTurn, afterModelTurn(usage), beforeToolCall }`, and `createRunGuard({ withTenant, viewer, killedEverywhere, dailyTokens?, now? })`. `modelTurn` and `runTool` call it themselves, so no runner can forget it. A stop throws `RunHalted(reason)`, which `runTool` lets through rather than handing it to the model. The kill switch is `AGENT_KILL_SWITCH=1` (read by `agentGuard` in `src/lib/agent-tools.ts`) or the tenant's `agent_switches` row with `enabled = false` (reason `kill switch: <reason>`). The budget is per user per UTC day: checked before each turn (`token_limit - tokens_used <= 0` stops it), charged after it by one upsert. The day's first charge writes `token_limit` (500,000 by default), so raising one user's limit is an UPDATE of their row. Check and charge are separate statements, so two turns at once can overshoot by a turn.
- **`runTool`**: unknown tool, schema failure (zod's `prettifyError`), a thrown error and a timeout (30 s, raced, so a tool that ignores its signal still can't hold the loop) all come back `ok: false`. The idempotency key is `agent:<runId>:<callId>`. `runTools` runs a turn's calls with `Promise.allSettled` and returns the results in call order.
- **Tools** (`#learn/agent/tools/index` `createAgentTools(deps)`, deps `{ withTenant, retrieve, workspace(tenantId) }`). `search_documents { query, k|null }`: `retrieve` as the viewer, k at most 8. `read_document { documentId, fromChunk|null }`: `canRead` first, then the current version's chunks in order up to 3,000 tokens (always at least one), with `nextChunk` to read on. `find_person { query }`: enabled users and groups of the viewer's tenant, matched by name, display name or email (LIKE wildcards escaped), users first, 10 at most. `send_mail { to[], subject, body, attachmentDocumentIds[] }` and `share_document { documentId, recipientId, role: "read" }`: `canRead` on every document before any request; the recipient must be an enabled principal of the tenant. Missing and unreadable documents get the same error, so an answer never says a document exists.
- **Graph writes** (`#learn/agent/tools/workspace`). `createWorkspaceWriter({ baseUrl, site, token })` sends `Idempotency-Key` and retries a 429 or 5xx twice with the same key, after `Retry-After` (capped at 10 s). Attachments are Graph `referenceAttachment`s whose `sourceUrl` ends in `/drives/{site}/items/{driveItemId}`. In `src/lib/agent-tools.ts`, `agentTools()` wires the app's `withTenant`, `retrieve` and the tenant's site and token (from `src/workflows/sync-common.ts`).
- **fake-workspace.** `POST /v1.0/users/{id}/sendMail` (202, kept in memory, nothing delivered): an unknown sender 404, a disabled one 403, an attachment from another drive, missing or a folder 400, one the sender can't read 403 (the second line of defence, from the item's effective grants and the directory's nested groups). `POST /v1.0/drives/{site}/items/{item}/invite` (`recipients[].objectId`, `roles: ["read"|"write"]`; 200 with the recipients' permissions): adds the grant to the item's own sharing, records a sharing change and notifies, so delta and the webhook carry it; a principal already holding the role changes nothing. Idempotency is per site and key: the fingerprint is method, path and the parsed body; only 2xx answers are kept (a refused request changed nothing); a replay carries `Idempotent-Replayed: true`; another body gets 422 `idempotencyKeyReused`. The lookup runs after every `await`, so two requests with one key send once. `GET /_control/mail` lists sent mail; `/_control/reset` clears it and the keys. Faults match these paths like any other (`path_prefix: "/v1.0/users"` or `"/v1.0/drives"`).
- **Test runner.** `#learn/agent/loop-testing` has `inMemoryRun`, `naiveContext` and `drive(run, options)`: decide, do, append over an in-memory log, stopping at an approval unless `approve` answers it. Tests and the live proof use it; the app uses lane B's runner.
- **Live proof** (gpt-6-luna, real retrieval). As `leo.martin`, "email Tom a summary of KPC-2026-0142's payment terms": `search_documents`, `read_document` on the executed MSA, `find_person`, then `send_mail` stopped at the approval with a correct draft. Four turns, 15,324 tokens in and 287 out, about $0.0017, 11 s.
