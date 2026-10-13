import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageStreamWriter } from "ai";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ChatModel, ReasoningEffort } from "#learn/model/types";
import type { Retrieve, Viewer } from "#learn/retrieve/types";
import type { ChatUIMessage, SourceRef, Verdict } from "@/components/chat/types";
import type { Db } from "@/db/create";

import { validateCitations, type CitableSource } from "#learn/cite/citations";
import { answer, type AnswerResult } from "#learn/generate/answer";
import { withTenantOn } from "@/db/tenant";
import { createLogger } from "@/lib/logger";
import { takeToken, type Bucket } from "@/lib/rate-limit";

import { beginTurn, saveReply, type ReplyContent, type StoredReply } from "./-store";

const logger = createLogger("chat");

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_QUESTION_CHARS = 4000;
export const HEARTBEAT_MS = 15_000;

/** What the browser sends: the conversation id and only the newest message (the server keeps the history). The
 * message id is the idempotency key. Nothing here names a tenant or a user: those come from the session. */
export const ChatRequestSchema = z.object({
  id: z.uuid(),
  message: z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    role: z.literal("user"),
    parts: z
      .array(z.object({ type: z.literal("text"), text: z.string() }))
      .min(1)
      .max(8),
  }),
});

export interface ChatDeps {
  db: Db;
  retrieve: Retrieve;
  model: ChatModel;
  reasoningEffort: ReasoningEffort;
  bucket: Bucket;
  now?: () => Date;
  heartbeatMs?: number;
  maxOutputTokens?: number;
}

function pgCode(error: unknown): string | undefined {
  for (let e = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

const json = (status: number, body: Record<string, unknown>, headers: HeadersInit = {}) =>
  Response.json(body, { status, headers });

/** `POST /api/chat`, behind `viewerMiddleware` (which gives `scope`): one question in, one answer streamed back as
 * a UI message stream. */
export async function handleChat(request: Request, scope: Viewer, deps: ChatDeps): Promise<Response> {
  // Content-length can be missing or wrong, so the body is measured again once read.
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return json(413, { error: "too_large" });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "too_large" });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) return json(400, { error: "invalid_request", issues: z.flattenError(parsed.error).fieldErrors });

  const question = parsed.data.message.parts
    .map((p) => p.text)
    .join("\n")
    .trim();
  if (!question) return json(400, { error: "empty_question" });
  if (question.length > MAX_QUESTION_CHARS) return json(400, { error: "question_too_long", max: MAX_QUESTION_CHARS });

  const inTenant = <T>(fn: Parameters<typeof withTenantOn<T>>[2]) => withTenantOn(deps.db, scope.tenantId, fn);

  let limit;
  try {
    limit = await inTenant((tx) => takeToken(tx, scope, deps.bucket, (deps.now ?? (() => new Date()))()));
  } catch (error) {
    // The bucket's foreign key: a signed-in user the directory hasn't synced has no principal, so no data either.
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

  const conversationId = parsed.data.id;
  const userKey = parsed.data.message.id;
  const turn = await inTenant((tx) => beginTurn(tx, scope, conversationId, { key: userKey, text: question }));
  if (turn.kind === "not-found") return json(404, { error: "not_found" });

  // The client going away (request.signal) or the response stream being cancelled both stop the work.
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(request.signal.reason), { once: true });

  const stream =
    turn.kind === "replay"
      ? replay(turn.reply)
      : createUIMessageStream<ChatUIMessage>({
          execute: ({ writer }) =>
            respond(writer, {
              deps,
              question,
              history: turn.history,
              signal: abort.signal,
              save: (reply) => inTenant((tx) => saveReply(tx, scope, conversationId, { ...reply, userKey })),
              scope,
            }),
          onError: (error) => {
            logger.error("chat turn failed", { error, conversationId });
            return "Something went wrong while answering. Try again.";
          },
        });

  const response = createUIMessageStreamResponse({ stream });
  return new Response(
    withHeartbeat(response.body!, deps.heartbeatMs ?? HEARTBEAT_MS, () => abort.abort()),
    {
      status: response.status,
      headers: response.headers,
    },
  );
}

async function respond(
  writer: UIMessageStreamWriter<ChatUIMessage>,
  {
    deps,
    question,
    history,
    signal,
    save,
    scope,
  }: {
    deps: ChatDeps;
    question: string;
    history: Parameters<typeof answer>[0]["history"];
    signal: AbortSignal;
    save: (reply: { id: string; content: ReplyContent }) => Promise<boolean>;
    scope: Viewer;
  },
) {
  const id = randomUUID();
  writer.write({ type: "start", messageId: id });

  const retrieval = await deps.retrieve(scope, question);
  let sources: SourceRef[] = [];
  let fullSources: CitableSource[] = [];
  let text = "";
  let result: AnswerResult | null = null;
  let textStarted = false;

  try {
    for await (const event of answer({
      question,
      history,
      retrieval,
      model: deps.model,
      reasoningEffort: deps.reasoningEffort,
      maxOutputTokens: deps.maxOutputTokens,
      abortSignal: signal,
    })) {
      if (event.type === "sources") {
        fullSources = event.sources;
        sources = event.sources.map(({ text: _text, ...ref }) => ref);
        writer.write({ type: "data-sources", id: "sources", data: { sources } });
      } else if (event.type === "text-delta") {
        if (!textStarted) writer.write({ type: "text-start", id: "text" });
        textStarted = true;
        text += event.delta;
        writer.write({ type: "text-delta", id: "text", delta: event.delta });
      } else {
        result = event.result;
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
    // The client left: keep what it saw, marked as stopped. Nobody is reading the stream any more.
    // Its citations are checked like a finished answer's, but a cut-off answer isn't flagged for lacking them.
    const report = validateCitations(text, fullSources);
    const partial: AnswerResult = {
      text,
      report,
      abstained: false,
      flagged: report.dropped.length > 0,
      finishReason: "other",
      usage: null,
    };
    await save({
      id,
      content: replyContent({ text, sources, result: partial, status: "aborted", retrieval, model: deps.model.id }),
    });
    logger.info("chat turn aborted", { chars: text.length });
    return;
  }

  if (textStarted) writer.write({ type: "text-end", id: "text" });
  const content = replyContent({ text, sources, result, status: "complete", retrieval, model: deps.model.id });
  writer.write({ type: "data-verdict", id: "verdict", data: content.verdict });
  await save({ id, content });
  writer.write({ type: "finish", finishReason: "stop" });
}

function replyContent({
  text,
  sources,
  result,
  status,
  retrieval,
  model,
}: {
  text: string;
  sources: SourceRef[];
  result: AnswerResult | null;
  status: ReplyContent["status"];
  retrieval: { auditId: string };
  model: string;
}): ReplyContent {
  const verdict: Verdict = result
    ? {
        citations: result.report.citations,
        dropped: result.report.dropped,
        abstained: result.abstained,
        flagged: result.flagged,
      }
    : { citations: [], dropped: [], abstained: false, flagged: false };
  return {
    text,
    status,
    sources,
    verdict,
    auditId: retrieval.auditId,
    model,
    finishReason: status === "aborted" ? "aborted" : (result?.finishReason ?? "other"),
    usage: result?.usage ?? null,
  };
}

/** A stored reply, streamed again for a retried request. */
function replay(reply: StoredReply) {
  return createUIMessageStream<ChatUIMessage>({
    execute: ({ writer }) => {
      writer.write({ type: "start", messageId: reply.id, messageMetadata: { status: reply.content.status } });
      writer.write({ type: "data-sources", id: "sources", data: { sources: reply.content.sources } });
      writer.write({ type: "text-start", id: "text" });
      writer.write({ type: "text-delta", id: "text", delta: reply.content.text });
      writer.write({ type: "text-end", id: "text" });
      writer.write({ type: "data-verdict", id: "verdict", data: reply.content.verdict });
      writer.write({ type: "finish", finishReason: "stop" });
    },
  });
}

const HEARTBEAT = new TextEncoder().encode(": heartbeat\n\n");

/**
 * Sends an SSE comment every `intervalMs` while the answer is quiet (retrieval and reasoning can take a while),
 * so proxies don't close an idle connection. Clients ignore comments. Upstream chunks are whole events, so a
 * heartbeat never lands inside one. `onCancel` runs when the client goes away.
 */
export function withHeartbeat(
  body: ReadableStream<Uint8Array>,
  intervalMs: number,
  onCancel: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setInterval> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        try {
          controller.enqueue(HEARTBEAT);
        } catch {
          clearInterval(timer);
        }
      }, intervalMs);
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          clearInterval(timer);
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        clearInterval(timer);
        controller.error(error);
      }
    },
    async cancel(reason) {
      clearInterval(timer);
      onCancel();
      await reader.cancel(reason);
    },
  });
}
