import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Viewer } from "#learn/retrieve/types";
import type { Db } from "@/db/create";

import { readEvents, toSse } from "#learn/agent/events";
import { isFinal } from "#learn/agent/state";
import { conversations } from "@/db/schema";
import { withTenantOn } from "@/db/tenant";
import { addMessage, loadRun, type MessageResult, startRun } from "@/lib/agent-runs";
import { takeToken, type Bucket } from "@/lib/rate-limit";
import { HEARTBEAT_MS, withHeartbeat } from "@/routes/api/chat/-chat";

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_MESSAGE_CHARS = 4000;
export const STREAM_POLL_MS = 250;
const STREAM_PAGE = 500;

/** Five runs in a burst, then one every 30 seconds. The daily token budget (section 13) is the real cap. */
export const RUN_BUCKET: Bucket = { name: "agent", capacity: 5, refillPerSecond: 1 / 30 };

const MessageSchema = z.object({
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
  bucket?: Bucket;
  now?: () => Date;
  pollMs?: number;
  heartbeatMs?: number;
}

const json = (status: number, body: Record<string, unknown>, headers: HeadersInit = {}) =>
  Response.json(body, { status, headers });

const notFound = () => json(404, { error: "not_found" });

function pgCode(error: unknown): string | undefined {
  for (let e = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T | Response> {
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

function answer(result: MessageResult, runId: string, viewer: Viewer, deps: RunRoutesDeps): Response {
  if (result.kind === "not-found") return notFound();
  if (result.kind === "finished") return json(409, { error: "run_finished", status: result.status });
  // A running run's runner sees the message on its next step; a queued or waiting one needs starting.
  if (result.status === "queued" || result.status === "waiting") deps.kick(viewer, runId);
  return json(202, { id: runId, seq: result.seq, duplicate: result.kind === "duplicate" });
}

/** `POST /api/runs`: starts an agent run with its first message. The work happens after the answer; the client
 * follows it on `GET /api/runs/:id/stream`. */
export async function handleStartRun(request: Request, viewer: Viewer, deps: RunRoutesDeps): Promise<Response> {
  const body = await readBody(request, StartRunSchema);
  if (body instanceof Response) return body;

  const now = (deps.now ?? (() => new Date()))();
  let limit;
  try {
    limit = await withTenantOn(deps.db, viewer.tenantId, (tx) => takeToken(tx, viewer, deps.bucket ?? RUN_BUCKET, now));
  } catch (error) {
    if (pgCode(error) === "23503") return json(403, { error: "not_in_directory" });
    throw error;
  }
  if (!limit.allowed) {
    return json(
      429,
      { error: "rate_limited", retryAfterSeconds: limit.retryAfterSeconds },
      { "retry-after": String(limit.retryAfterSeconds) },
    );
  }

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

/** `POST /api/runs/:id/messages`: a message into a live run. */
export async function handleAddMessage(
  request: Request,
  viewer: Viewer,
  runId: string,
  deps: RunRoutesDeps,
): Promise<Response> {
  if (!z.uuid().safeParse(runId).success) return notFound();
  const body = await readBody(request, AddMessageSchema);
  if (body instanceof Response) return body;
  const result = await addMessage(deps.db, viewer, runId, { messageId: body.message.id, text: body.message.text });
  return answer(result, runId, viewer, deps);
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

/**
 * `GET /api/runs/:id/stream`: the run's events as SSE, each with `id:` set to its `seq`. It tails `run_events`
 * (poll, send what's new, repeat) and ends once the run is final and every event is sent. A client that drops
 * reconnects with `Last-Event-ID` and gets only what it missed. Heartbeats keep a quiet stream open.
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

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!stop.signal.aborted) {
          // Status first, then events: once the status is final, every event before it is committed, so the read
          // after it sees them all.
          const { final, events } = await inTenant(async (tx) => {
            const run = await loadRun(tx, viewer, runId);
            return { final: !run || isFinal(run.status), events: await readEvents(tx, runId, after, STREAM_PAGE) };
          });
          if (events.length > 0) {
            after = events.at(-1)!.seq;
            controller.enqueue(encoder.encode(events.map(toSse).join("")));
            return;
          }
          if (final) {
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
