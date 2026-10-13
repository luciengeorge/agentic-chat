import type { ParsedDocument } from "#learn/parse/types";

export interface Chunk {
  ordinal: number;
  text: string;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  tokenCount: number;
}

export interface ChunkOptions {
  targetTokens?: number;
  overlapTokens?: number;
}

/** Implemented by `chunk` in `#learn/chunk/chunk`. */
export type ChunkDocument = (doc: ParsedDocument, options?: ChunkOptions) => Chunk[];
