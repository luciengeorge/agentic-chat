/**
 * The rerank lab's server side (section 08): one real retrieval for the viewer, with the reranker watched. The
 * reranker it's given is wrapped so it scores every candidate it's sent, and `retrieve` asks for 50, so each
 * candidate the reranker read comes back with its place before (fused order, found by its text in what the reranker
 * was sent) and after. It runs the app's own
 * `createRetrieve` through `#learn/*` (the learner's `rerankCandidates` and reranker while an 08 step is active),
 * and writes the usual audit row. Server only: the route's server function imports it.
 */
import type { Reranker } from "#learn/rerank/rerank";
import type { RetrieveDeps } from "#learn/retrieve/retrieve";
import type { Viewer } from "#learn/retrieve/types";

import { createRetrieve } from "#learn/retrieve/retrieve";

export interface RerankRow {
  id: string;
  title: string;
  path: string;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  /** The start of the chunk's text. */
  text: string;
  /** 1-based place in the fused order, among the candidates the viewer may read. */
  fused: number;
  /** 1-based place after the reranker. */
  reranked: number;
  score: number;
}

export interface RerankRun {
  question: string;
  reranker: string;
  depth: number;
  rewritten: string[];
  /** In reranked order: every candidate the reranker read. The first 8 (the app's k) are what the chat gets. */
  rows: RerankRow[];
  auditId: string;
}

export async function rerankRun(
  deps: RetrieveDeps,
  viewer: Viewer,
  question: string,
  depth: number,
): Promise<RerankRun> {
  if (!Number.isInteger(depth) || depth < 1 || depth > 50) throw new RangeError(`depth must be 1 to 50, got ${depth}`);
  let sent: string[] = [];
  const watched: Reranker = {
    name: deps.reranker.name,
    async rerank(query, documents) {
      sent = documents;
      return deps.reranker.rerank(query, documents, documents.length);
    },
  };
  const retrieval = await createRetrieve({ ...deps, reranker: watched }, { rerankDepth: depth })(viewer, question, {
    k: 50,
  });
  const used = new Set<number>();
  const fusedPlace = (text: string) => {
    const index = sent.findIndex((candidate, i) => candidate === text && !used.has(i));
    used.add(index);
    return index + 1;
  };
  const rows = retrieval.chunks.map((chunk, i): RerankRow => ({
    id: chunk.id,
    title: chunk.title,
    path: chunk.path,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    section: chunk.section,
    text: chunk.text.slice(0, 280),
    fused: fusedPlace(chunk.text),
    reranked: i + 1,
    score: chunk.score,
  }));
  return {
    question: retrieval.query,
    reranker: deps.reranker.name,
    depth,
    rewritten: retrieval.rewritten,
    rows,
    auditId: retrieval.auditId,
  };
}
