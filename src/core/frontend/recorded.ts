import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RunEvent } from "#learn/agent/types";
import type { ApprovalRow } from "@/components/agent/api";
import type { ConversationSummary, StoredUIMessage } from "@/components/chat/types";
import type { CitedChunk } from "@/routes/api/chat/-sources";

/**
 * Section 12's recordings (`fixtures/cassettes/frontend/`), made on 18 October 2026 through the dev server, signed
 * in as leo.martin: the chat answering "What's the daily meal allowance on a work trip?" (every read of the
 * response, with its time, and what the server functions returned before and after), and an agent run emailing Tom
 * Whitfield a contract's payment terms (its event stream up to the approval, the inbox's row, the decision, and
 * the stream again from `?after=12`).
 */

const DIR = join(import.meta.dirname, "../../../fixtures/cassettes/frontend");
const json = <T>(name: string) => JSON.parse(readFileSync(join(DIR, name), "utf8")) as T;

interface Read {
  /** Milliseconds after the response's headers arrived. */
  at: number;
  bytes: Uint8Array;
}

const reads = (raw: { at: number; bytes: string }[]): Read[] =>
  raw.map(({ at, bytes }) => ({ at, bytes: new Uint8Array(Buffer.from(bytes, "base64")) }));

const chat = json<{
  question: string;
  conversationId: string;
  router: { request: unknown; response: { route: "answer"; reason: string } };
  chat: { request: { id: string; message: unknown }; headersAt: number; reads: { at: number; bytes: string }[] };
  getConversation: { title: string | null; messages: StoredUIMessage[] };
  getConversationRuns: { id: string; afterMessages: number }[];
  getConversationsBefore: ConversationSummary[];
  getConversationsAfter: ConversationSummary[];
  getCitedChunk: Record<string, CitedChunk | null>;
}>("meal-allowance.json");

export const mealAllowance = {
  question: chat.question,
  conversationId: chat.conversationId,
  /** What `POST /api/chat/router` answered: a plain answer, so the chat sends the question to `/api/chat`. */
  routed: chat.router.response,
  /** The body `POST /api/chat` was sent. */
  request: chat.chat.request,
  /** The answer's bytes, read by read, as the browser got them. */
  reads: reads(chat.chat.reads),
  /** What `getConversation` returned once the answer was saved. */
  conversation: chat.getConversation,
  runs: chat.getConversationRuns,
  /** leo's sidebar (`getConversations`), before the question and after its answer. */
  conversationsBefore: chat.getConversationsBefore,
  conversationsAfter: chat.getConversationsAfter,
  /** What `getCitedChunk` returned for each cited chunk. */
  citedChunks: chat.getCitedChunk,
};

/** One server-sent event: `message` (a run event, with its `id`) or `token` (a delta of the turn in progress). */
export interface SseMessage {
  event: string;
  id: string | null;
  data: string;
}

/** The events in an SSE body, comments (heartbeats) left out. */
export function parseSseText(text: string): SseMessage[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim() && !block.split("\n").every((line) => line.startsWith(":")))
    .map((block) => {
      const message: SseMessage = { event: "message", id: null, data: "" };
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) message.id = line.slice(4);
        else if (line.startsWith("event: ")) message.event = line.slice(7);
        else if (line.startsWith("data: ")) message.data += line.slice(6);
      }
      return message;
    });
}

const run = json<{
  router: { response: { id: string } };
  stream1: { url: string };
  approvals: ApprovalRow[];
  decide: { url: string; request: { decision: "approved" }; response: unknown };
  stream2: { url: string };
}>("kpc-email-run.json");
const part1 = parseSseText(readFileSync(join(DIR, "kpc-email-run.part1.sse"), "utf8"));
const part2 = parseSseText(readFileSync(join(DIR, "kpc-email-run.part2.sse"), "utf8"));
const eventsOf = (messages: SseMessage[]) =>
  messages.filter((m) => m.event === "message").map((m) => JSON.parse(m.data) as RunEvent);

export const kpcEmailRun = {
  runId: run.router.response.id,
  /** The first connection, from the top until the run waits on its approval (seq 12), tokens included. */
  first: { url: run.stream1.url, messages: part1 },
  /** The inbox's row while it waited (`GET /api/approvals?status=pending`). */
  approval: run.approvals[0],
  decide: run.decide,
  /** The connection after the reload, `?after=12`: seq 13 to 17. */
  second: { url: run.stream2.url, messages: part2 },
  events: [...eventsOf(part1), ...eventsOf(part2)],
};
