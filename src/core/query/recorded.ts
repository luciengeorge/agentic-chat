/**
 * Retrieval recorded once against the dev stack (real embeddings, the real rewriter, HyDE and Cohere), replayed by
 * section 08's tests so nothing in them calls a model or Cohere. Recorded on 2026-10-18 by a script that isn't
 * committed (it ran retrieval's own search functions and checked its pool against `createRetrieve`'s). A live run
 * moves a few places from these: OpenAI's query embeddings aren't bit-identical between calls.
 *
 * - `FOS_DECISION`: sofia.lindqvist asks the golden question `filing-fos-decision`. Every list search made, the 30
 *   candidates the reranker read, the rewrite, the HyDE passage, and Cohere's two answers (30 candidates and 8).
 * - `CHRISTMAS_FREEZE`: sam.patel asks "When can't we ship code over Christmas?", with the rewrite and every list.
 * - `MERCHANT_EXIT_CARDS`: the 15 document cards routing builds for sofia.lindqvist, and her question's vector, for
 *   the golden question `filing-merchant-exit`.
 */
import type { Embedder } from "#learn/embed/embed";
import type { DocumentCard } from "#learn/query/route";

import christmasJson from "../../../fixtures/cassettes/query/christmas-freeze.json?raw";
import fosJson from "../../../fixtures/cassettes/query/fos-decision.json?raw";
import cardsJson from "../../../fixtures/cassettes/query/merchant-exit-cards.json?raw";

export interface Exchange {
  url: string;
  request: Record<string, unknown>;
  status: number;
  response: Record<string, unknown>;
}

/** One ranked list search made: BM25 or vector, for the question or one rewrite. Ids best first. */
export interface RecordedList {
  query: string;
  kind: "bm25" | "vector";
  ids: string[];
}

export interface RecordedCandidate {
  id: string;
  documentId: string;
  title: string;
  path: string;
  text: string;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
}

export interface RecordedLabel {
  path: string;
  page: number | null;
  /** The chunks that hold the label's page (or, for `CHRISTMAS_FREEZE`, its one table). */
  chunkIds: string[];
}

interface FosRecording {
  recorded: string;
  user: string;
  question: string;
  labels: RecordedLabel[];
  rewrites: string[];
  passage: string;
  /** Question first, then each rewrite: BM25, then vector. */
  lists: RecordedList[];
  /** The vector list for HyDE's passage. */
  hydeList: string[];
  /** The 30 allowed candidates in fused order: what the reranker read at the default depth. */
  pool: RecordedCandidate[];
  embeddings: Record<string, string>;
  exchanges: { rewrite: Exchange; hyde: Exchange; cohere30: Exchange; cohere8: Exchange };
}

interface ChristmasRecording {
  recorded: string;
  user: string;
  question: string;
  labels: (RecordedLabel & { section: string; text: string })[];
  rewrites: string[];
  lists: RecordedList[];
  /** Each listed chunk's document path. */
  paths: Record<string, string>;
  exchanges: { rewrite: Exchange };
}

interface CardsRecording {
  recorded: string;
  user: string;
  question: string;
  labels: { path: string; page: number }[];
  questionEmbedding: string;
  cards: (Omit<DocumentCard, "embedding"> & { embedding: string | null })[];
}

/** A vector stored as base64 float32, which is what pgvector keeps. */
export function decodeVector(base64: string): number[] {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return [...new Float32Array(bytes.buffer)];
}

export const FOS_DECISION = JSON.parse(fosJson) as FosRecording;
export const CHRISTMAS_FREEZE = JSON.parse(christmasJson) as ChristmasRecording;

const cards = JSON.parse(cardsJson) as CardsRecording;
export const MERCHANT_EXIT_CARDS = {
  ...cards,
  questionEmbedding: decodeVector(cards.questionEmbedding),
  cards: cards.cards.map((card): DocumentCard => ({
    ...card,
    embedding: card.embedding === null ? null : decodeVector(card.embedding),
  })),
};

/** A recorded vector of `FOS_DECISION`: `question`, `passage`, or a label chunk's id. */
export function fosVector(key: string): number[] {
  const base64 = FOS_DECISION.embeddings[key];
  if (!base64) throw new Error(`no recorded vector for ${key}`);
  return decodeVector(base64);
}

export interface Replay {
  fetch: typeof globalThis.fetch;
  /** The JSON body of each call, in order. */
  requests: Record<string, unknown>[];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that answers every call with `exchange`'s recorded response, whatever is sent, and keeps what was. */
export function replay(exchange: Exchange): Replay {
  const requests: Record<string, unknown>[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return json(exchange.response, exchange.status);
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

/**
 * Cohere, replayed: a call that sends the same documents as one of `FOS_DECISION`'s two recordings (the first 30
 * candidates, or the first 8) gets its answer. Anything else fails and says what was sent.
 */
export function replayCohere(): Replay {
  const requests: Record<string, unknown>[] = [];
  const recordings = [FOS_DECISION.exchanges.cohere30, FOS_DECISION.exchanges.cohere8];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string; documents?: string[]; top_n?: number };
    requests.push(body);
    const sent = body.documents ?? [];
    const match = recordings.find((recording) => {
      const documents = recording.request.documents as string[];
      return documents.length === sent.length && documents.every((text, i) => text === sent[i]);
    });
    if (!match) {
      throw new Error(
        `Cohere was sent ${sent.length} documents; the recordings hold the first 30 candidates and the first 8, ` +
          "in fused order. Send the candidates' text, the first `depth` of them",
      );
    }
    return json(match.response, match.status);
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

/** An embedder that knows only the texts it's given, with their recorded vectors. Any other text throws. */
export function recordedEmbedder(vectors: Record<string, number[]>, version = "text-embedding-3-small@1536"): Embedder {
  return {
    version,
    dimensions: 1536,
    async embed(values) {
      return values.map((value) => {
        const vector = vectors[value];
        if (!vector) {
          throw new Error(
            `no recorded embedding for ${JSON.stringify(value.slice(0, 80))}: only whole recorded texts have one`,
          );
        }
        return vector;
      });
    },
  };
}
