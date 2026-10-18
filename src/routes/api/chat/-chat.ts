import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageStreamWriter } from "ai";
import { randomUUID } from "node:crypto";

import type { ChatModel, ReasoningEffort } from "#learn/model/types";
import type { Retrieve, Viewer } from "#learn/retrieve/types";
import type { ChatUIMessage, SourceRef, Verdict } from "@/components/chat/types";
import type { Db } from "@/db/create";

import { readChatTurn } from "#learn/boundary/chat-request";
import { takeToken, type Bucket } from "#learn/boundary/rate-limit";
import { HEARTBEAT_MS, withHeartbeat } from "#learn/boundary/stream";
import { validateCitations } from "#learn/cite/citations";
import { answer, type AnswerResult } from "#learn/generate/answer";
import { sourceRef, verdictOf, writeAnswer, type StreamedAnswer } from "#learn/generate/stream";
import { withTenantOn } from "@/db/tenant";
import { createLogger } from "@/lib/logger";

import { beginTurn, saveReply, type ReplyContent, type StoredReply } from "./-store";

const logger = createLogger("chat");

/** The request's limits live in `#learn/boundary/chat-request` (section 11.3), the heartbeat in
 * `#learn/boundary/stream` (11.5). */
export { ChatRequestSchema, MAX_BODY_BYTES, MAX_QUESTION_CHARS } from "#learn/boundary/chat-request";
export { HEARTBEAT_MS, withHeartbeat };

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
export async function handleChat(request: Request, viewer: Viewer, deps: ChatDeps): Promise<Response> {
  const chat = await readChatTurn(request, viewer);
  if (chat instanceof Response) return chat;
  // From here on, everything acts for the turn's scope: the session's viewer, never anything the body said.
  const { scope, question, conversationId, messageKey: userKey } = chat;

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
  const streamed: StreamedAnswer = { sources: [], text: "", result: null };

  try {
    await writeAnswer(
      writer,
      answer({
        question,
        history,
        retrieval,
        model: deps.model,
        reasoningEffort: deps.reasoningEffort,
        maxOutputTokens: deps.maxOutputTokens,
        abortSignal: signal,
      }),
      streamed,
    );
  } catch (error) {
    if (!signal.aborted) throw error;
    // The client left: keep what it saw, marked as stopped. Nobody is reading the stream any more.
    // Its citations are checked like a finished answer's, but a cut-off answer isn't flagged for lacking them.
    const { text } = streamed;
    const report = validateCitations(text, streamed.sources);
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
      content: replyContent({
        text,
        sources: streamed.sources.map(sourceRef),
        result: partial,
        status: "aborted",
        retrieval,
        model: deps.model.id,
      }),
    });
    logger.info("chat turn aborted", { chars: text.length });
    return;
  }

  const content = replyContent({
    text: streamed.text,
    sources: streamed.sources.map(sourceRef),
    result: streamed.result,
    status: "complete",
    retrieval,
    model: deps.model.id,
  });
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
    ? verdictOf(result)
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
