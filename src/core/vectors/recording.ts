/**
 * Real text-embedding-3-small vectors for sections 06 and 07, written once by `pnpm vectors:record` from the dev
 * database (`fixtures/vectors/recording/`): every chunk outside the 3,000-page filing with its text and embedding,
 * and the golden questions with theirs. Tests and labs read them, so nothing calls OpenAI.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../../../fixtures/vectors/recording/", import.meta.url));

export const RECORDED_MODEL = "text-embedding-3-small@1536";
export const RECORDED_DIMENSIONS = 1536;

export interface RecordedChunk {
  /** `<path>#<ordinal>`: stable across re-recordings, unlike the dev database's ids. */
  key: string;
  tenant: "kestrel" | "harbour";
  path: string;
  title: string;
  mimeType: string;
  ordinal: number;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  tokenCount: number;
  text: string;
  embedding: number[];
}

export interface RecordedQuery {
  /** The golden question's id (`fixtures/golden/questions.yaml`). */
  id: string;
  tenant: "kestrel" | "harbour";
  user: string;
  question: string;
  embedding: number[];
}

function vectors(file: string, count: number): number[][] {
  const bytes = readFileSync(`${DIR}${file}`);
  if (bytes.length !== count * RECORDED_DIMENSIONS * 4) throw new Error(`${file} doesn't hold ${count} vectors`);
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  return Array.from({ length: count }, (_, i) =>
    Array.from(floats.subarray(i * RECORDED_DIMENSIONS, (i + 1) * RECORDED_DIMENSIONS)),
  );
}

let chunks: RecordedChunk[] | undefined;
let queries: RecordedQuery[] | undefined;
let filing: { path: string; tokenCounts: number[] } | undefined;

function loadChunks() {
  const file = JSON.parse(readFileSync(`${DIR}chunks.json`, "utf8")) as {
    filing: { path: string; tokenCounts: number[] };
    chunks: Omit<RecordedChunk, "key" | "embedding">[];
  };
  const embeddings = vectors("chunks.f32", file.chunks.length);
  filing = file.filing;
  chunks = file.chunks.map((chunk, i) => ({
    key: `${chunk.path}#${chunk.ordinal}`,
    ...chunk,
    embedding: embeddings[i],
  }));
}

/** The 434 chunks outside the filing, both tenants, ordered by tenant, path and ordinal. */
export function recordedChunks(): RecordedChunk[] {
  if (!chunks) loadChunks();
  return chunks!;
}

/** The 3,000-page filing's chunks, token counts only, in order: 5,274 of them. */
export function filingTokenCounts(): { path: string; tokenCounts: number[] } {
  if (!filing) loadChunks();
  return filing!;
}

/** The 46 golden questions, as embedded for the bench, then three bare identifiers (`kpc-2026-0142`, `kp-4031`,
 * `kpc-2026-0298`) for section 07. */
export function recordedQueries(): RecordedQuery[] {
  if (!queries) {
    const meta = JSON.parse(readFileSync(`${DIR}queries.json`, "utf8")) as Omit<RecordedQuery, "embedding">[];
    const embeddings = vectors("queries.f32", meta.length);
    queries = meta.map((query, i) => ({ ...query, embedding: embeddings[i] }));
  }
  return queries;
}

/** Only the golden questions: what the bench measures recall over. */
export const goldenQueries = () => recordedQueries().filter((q) => q.question.includes(" "));

export function recordedQuery(id: string): RecordedQuery {
  const query = recordedQueries().find((q) => q.id === id);
  if (!query) throw new Error(`no recorded query ${id}`);
  return query;
}

export function recordedChunk(key: string): RecordedChunk {
  const chunk = recordedChunks().find((c) => c.key === key);
  if (!chunk) throw new Error(`no recorded chunk ${key}`);
  return chunk;
}

/**
 * One chunk per distinct vector, the first of each. A few chunks repeat word for word (the same policy in two
 * folders), and identical vectors tie: an exact scan and HNSW may each pick a different twin, which recall would
 * count as a miss.
 */
export function distinctChunks(list: RecordedChunk[] = recordedChunks()): RecordedChunk[] {
  const seen = new Set<string>();
  return list.filter((chunk) => {
    const id = chunk.embedding.join(",");
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Cosine similarity: the dot product over the two lengths. 1 is the same direction, 0 unrelated. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}
