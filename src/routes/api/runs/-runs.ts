import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { RunEvent, RunEventData } from "#learn/agent/types";
import type { Viewer } from "#learn/retrieve/types";
import type { Db } from "@/db/create";
import type { TokenChunk } from "@/workflows/agent-run-steps";

import { toRunEvent, toSse } from "#learn/agent/events";
import { isFinal } from "#learn/agent/state";
import { conversations } from "@/db/schema";
import { type Tx, withTenantOn } from "@/db/tenant";
import { addMessage, cancelRun, loadRun, type MessageResult, type RunWaker, startRun } from "@/lib/agent-runs";
import { takeToken, type Bucket } from "@/lib/rate-limit";
import { HEARTBEAT_MS, withHeartbeat } from "@/routes/api/chat/-chat";

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_MESSAGE_CHARS = 4000;
export const STREAM_POLL_MS = 250;
const STREAM_PAGE = 500;

/** Five runs in a burst, then one every 30 seconds. The daily token budget (section 13) is the real cap. */
export const RUN_BUCKET: Bucket = { name: "agent", capacity: 5, refillPerSecond: 1 / 30 };

/** Messages into a live run: twenty in a burst, then one every 3 s. It's the chat router's bucket
 * (`ROUTER_BUCKET`), so a follow-up draws on the same tokens whichever route it takes. */
export const FOLLOW_UP_BUCKET: Bucket = { name: "router", capacity: 20, refillPerSecond: 20 / 60 };

export const MessageSchema = z.object({
  /** The client's id: a resend with the same id stores nothing new. */
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
});

/** Nothing here names a tenant or a user: those come from the session. The run id is the client's, so a retried
 * start makes one run. */
export const StartRunSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid().optional(),
  message: MessageSchema,
});

export const AddMessageSchema = z.object({ message: MessageSchema });

export interface RunRoutesDeps {
  db: Db;
  /** Starts the runner for a run that has work, without waiting for it. */
  kick: (viewer: Viewer, runId: string) => void;
  /** Tells the runner holding a run about an approval decision or a cancel (`AGENT_RUNNER` picks which). */
  wake?: RunWaker;
  /** The run's live tokens, from the given Workflow run (`getWritable()` in its model steps), starting now: a
   * reconnect gets none it missed. Absent for the runners that don't stream tokens. */
  tokens?: (workflowRunId: string) => Promise<ReadableStream<TokenChunk>>;
  bucket?: Bucket;
  /** For `POST /api/runs/:id/messages`; `FOLLOW_UP_BUCKET` unless set. */
  messageBucket?: Bucket;
  now?: () => Date;
  pollMs?: number;
  heartbeatMs?: number;
}

export const json = (status: number, body: Record<string, unknown>, headers: HeadersInit = {}) =>
  Response.json(body, { status, headers });

const notFound = () => json(404, { error: "not_found" });

export function pgCode(error: unknown): string | undefined {
  for (let e = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T | Response> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return json(413, { error: "too_large" });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "too_large" });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return json(400, { error: "invalid_request", issues: z.flattenError(parsed.error).fieldErrors });
  return parsed.data;
}

/** Takes one token from the viewer's bucket: null when allowed, else the 429 (or the 403 for a user the directory
 * hasn't synced) to answer with. */
export async function takeOrRefuse(db: Db, viewer: Viewer, bucket: Bucket, now: Date): Promise<Response | null> {
  let limit;
  try {
    limit = await withTenantOn(db, viewer.tenantId, (tx) => takeToken(tx, viewer, bucket, now));
  } catch (error) {
    if (pgCode(error) === "23503") return json(403, { error: "not_in_directory" });
    throw error;
  }
  if (limit.allowed) return null;
  const { retryAfterSeconds } = limit;
  return json(429, { error: "rate_limited", retryAfterSeconds }, { "retry-after": String(retryAfterSeconds) });
}

function answer(result: MessageResult, runId: string, viewer: Viewer, deps: RunRoutesDeps): Response {
  if (result.kind === "not-found") return notFound();
  if (result.kind === "finished") return json(409, { error: "run_finished", status: result.status });
  // Every live run is kicked, a running one too: a live runner just wakes (its next step reads the message), and a
  // runner that died while the run was `running` is replaced. Each runner's kick is idempotent.
  deps.kick(viewer, runId);
  return json(202, { id: runId, seq: result.seq, duplicate: result.kind === "duplicate" });
}

/** `POST /api/runs`: starts an agent run with its first message. The work happens after the answer; the client
 * follows it on `GET /api/runs/:id/stream`. */
export async function handleStartRun(request: Request, viewer: Viewer, deps: RunRoutesDeps): Promise<Response> {
  const body = await readBody(request, StartRunSchema);
  if (body instanceof Response) return body;
  return startRunResponse(viewer, body, deps);
}

/** Starts the run (rate-limited, in a conversation of the viewer's) and kicks its runner: 202 `{ id, seq,
 * duplicate }`. The chat router uses it too. */
export async function startRunResponse(
  viewer: Viewer,
  body: z.infer<typeof StartRunSchema>,
  deps: RunRoutesDeps,
): Promise<Response> {
  const refused = await takeOrRefuse(deps.db, viewer, deps.bucket ?? RUN_BUCKET, (deps.now ?? (() => new Date()))());
  if (refused) return refused;

  if (body.conversationId) {
    const conversationId = body.conversationId;
    const [own] = await withTenantOn(deps.db, viewer.tenantId, (tx) =>
      tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.userId, viewer.userId))),
    );
    if (!own) return notFound();
  }

  const result = await startRun(deps.db, viewer, {
    runId: body.id,
    conversationId: body.conversationId,
    message: { messageId: body.message.id, text: body.message.text },
  });
  return answer(result, body.id, viewer, deps);
}

/** `POST /api/runs/:id/messages`: a message into a live run, on the follow-up bucket. */
export async function handleAddMessage(
  request: Request,
  viewer: Viewer,
  runId: string,
  deps: RunRoutesDeps,
): Promise<Response> {
  if (!z.uuid().safeParse(runId).success) return notFound();
  const body = await readBody(request, AddMessageSchema);
  if (body instanceof Response) return body;
  const now = (deps.now ?? (() => new Date()))();
  const refused = await takeOrRefuse(deps.db, viewer, deps.messageBucket ?? FOLLOW_UP_BUCKET, now);
  if (refused) return refused;
  return addMessageResponse(viewer, runId, body.message, deps);
}

/** Adds the message to the live run (once per message id) and wakes its runner: 202 `{ id, seq, duplicate }`, or
 * 409 for a finished run. The chat router uses it for a follow-up. */
export async function addMessageResponse(
  viewer: Viewer,
  runId: string,
  message: { id: string; text: string },
  deps: RunRoutesDeps,
): Promise<Response> {
  const result = await addMessage(deps.db, viewer, runId, { messageId: message.id, text: message.text });
  return answer(result, runId, viewer, deps);
}

/** `POST /api/runs/:id/cancel`: stops the run, aborting a model turn or tool call in flight. */
export async function handleCancelRun(viewer: Viewer, runId: string, deps: RunRoutesDeps): Promise<Response> {
  const result = await cancelRun(deps.db, viewer, runId, deps.wake);
  if (result === "not-found") return notFound();
  if (result === "final") {
    const run = await withTenantOn(deps.db, viewer.tenantId, (tx) => loadRun(tx, viewer, runId));
    return json(409, { error: "run_finished", status: run?.status ?? null });
  }
  return json(202, { id: runId, status: "cancelled" });
}

/** Where a stream starts: after the `Last-Event-ID` the browser sends on reconnect, else `?after=`, else the top. */
function resumeFrom(request: Request): number {
  const header = request.headers.get("last-event-id");
  const query = new URL(request.url).searchParams.get("after");
  for (const value of [header, query]) {
    if (value !== null && /^\d{1,9}$/.test(value.trim())) return Number(value.trim());
  }
  return 0;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** A token line: no `id`, so a reconnect's `Last-Event-ID` stays the last event's seq. */
export const toTokenSse = (delta: string) => `event: token\ndata: ${JSON.stringify({ delta })}\n\n`;

/** Events after `after`, each with the step that wrote it (null outside Workflow). */
async function eventsAfter(tx: Tx, runId: string, after: number) {
  const rows = await tx.execute<{
    run_id: string;
    seq: number;
    at: Date | string;
    data: RunEventData;
    step_key: string | null;
  }>(sql`
    SELECT run_id, seq, at, data, step_key FROM run_events
    WHERE run_id = ${runId} AND seq > ${after}
    ORDER BY seq
    LIMIT ${STREAM_PAGE}`);
  return rows.map((row) => ({ event: toRunEvent(row) as RunEvent, stepKey: row.step_key }));
}

/**
 * `GET /api/runs/:id/stream`: the run's events as SSE, each with `id:` set to its `seq`. It tails `run_events`
 * (poll, send what's new, repeat) and ends once the run is final and every event is sent. A client that drops
 * reconnects with `Last-Event-ID` and gets only what it missed. Heartbeats keep a quiet stream open.
 *
 * For a Workflow run it also forwards the model's tokens as they stream (`event: token`), from the moment it
 * connects. A token of a turn whose event was already sent is dropped: the event has the whole text.
 */
export async function handleStream(
  request: Request,
  viewer: Viewer,
  runId: string,
  deps: RunRoutesDeps,
): Promise<Response> {
  if (!z.uuid().safeParse(runId).success) return notFound();
  const inTenant = <T>(fn: Parameters<typeof withTenantOn<T>>[2]) => withTenantOn(deps.db, viewer.tenantId, fn);
  if (!(await inTenant((tx) => loadRun(tx, viewer, runId)))) return notFound();

  const stop = new AbortController();
  request.signal.addEventListener("abort", () => stop.abort(), { once: true });
  const encoder = new TextEncoder();
  let after = resumeFrom(request);
  /** Turns whose event has been sent, by the step that wrote them. */
  const sentTurns = new Set<string>();
  let tokensFrom: string | null = null;
  let closed = false;

  async function forwardTokens(workflowRunId: string, controller: ReadableStreamDefaultController<Uint8Array>) {
    try {
      const reader = (await deps.tokens!(workflowRunId)).getReader();
      stop.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
      for (;;) {
        const { value, done } = await reader.read();
        if (done || closed) return;
        if (!sentTurns.has(value.turn)) controller.enqueue(encoder.encode(toTokenSse(value.delta)));
      }
    } catch {
      // Tokens are a nicety: the events carry everything.
    }
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!stop.signal.aborted) {
          // Status first, then events: once the status is final, every event before it is committed, so the read
          // after it sees them all.
          const { run, events } = await inTenant(async (tx) => {
            const run = await loadRun(tx, viewer, runId);
            return { run, events: await eventsAfter(tx, runId, after) };
          });
          if (deps.tokens && run?.workflowRunId && tokensFrom !== run.workflowRunId && !isFinal(run.status)) {
            tokensFrom = run.workflowRunId;
            void forwardTokens(run.workflowRunId, controller);
          }
          if (events.length > 0) {
            for (const { stepKey } of events) if (stepKey) sentTurns.add(stepKey.replace(/:\d+$/, ""));
            after = events.at(-1)!.event.seq;
            controller.enqueue(encoder.encode(events.map(({ event }) => toSse(event)).join("")));
            return;
          }
          if (!run || isFinal(run.status)) {
            closed = true;
            stop.abort();
            controller.close();
            return;
          }
          await sleep(deps.pollMs ?? STREAM_POLL_MS, stop.signal);
        }
      } catch (error) {
        if (!stop.signal.aborted) controller.error(error);
      }
    },
    cancel() {
      closed = true;
      stop.abort();
    },
  });

  return new Response(
    withHeartbeat(body, deps.heartbeatMs ?? HEARTBEAT_MS, () => stop.abort()),
    {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    },
  );
}
