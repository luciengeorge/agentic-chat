/**
 * `pnpm vectors:record`: writes the recording sections 06 and 07 test against, so their tests and labs use real
 * text-embedding-3-small vectors without calling OpenAI. It reads the dev database (after `pnpm db:embed`) and the
 * bench's query cache (`fixtures/vectors/cache/`, filled by `pnpm vectors:bench`), and writes
 * `fixtures/vectors/recording/`:
 *
 * - `chunks.json` and `chunks.f32`: every current chunk outside the 3,000-page filing (434, both tenants), with its
 *   text and its stored embedding as little-endian 32-bit floats, 1,536 per chunk, in the JSON's order. The filing
 *   is left out (its 5,274 vectors would be 32 MB); only its chunks' token counts are kept, for section 06.1.
 * - `queries.json` and `queries.f32`: the golden questions with their cached embeddings, in the golden set's order,
 *   then three bare identifiers (`EXTRA`), embedded once here if the cache lacks them.
 *
 * pgvector stores 32-bit floats, so the file holds exactly what the database does. Re-recording changes the
 * numbers in sections 06 and 07.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { loadGolden } from "@/fixtures/golden";
import { acEnv } from "@/lib/env";
import { embedderFromEnv } from "@/lib/retrieval.server";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CACHE = join(ROOT, "fixtures/vectors/cache/query-embeddings.json");
const OUT = join(ROOT, "fixtures/vectors/recording");
const MODEL = "text-embedding-3-small@1536";
const DIMENSIONS = 1536;
const FILING = "/Legal/Regulatory/FCA Annual Regulatory Return 2026.pdf";
/** Bare identifiers, for section 07: what an embedding makes of a contract number or an error code on its own. */
const EXTRA = ["KPC-2026-0142", "KP-4031", "KPC-2026-0298"];

function f32(vectors: number[][]): Buffer {
  const out = Buffer.alloc(vectors.length * DIMENSIONS * 4);
  vectors.forEach((vector, i) => {
    if (vector.length !== DIMENSIONS) throw new Error(`vector ${i} has ${vector.length} dimensions`);
    vector.forEach((value, j) => out.writeFloatLE(value, (i * DIMENSIONS + j) * 4));
  });
  return out;
}

async function main() {
  if (acEnv() !== "dev") throw new Error(`the recorder reads the dev stack; AC_ENV is ${acEnv()}`);
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error("DATABASE_ADMIN_URL must be set (.env.local)");
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql<
      {
        tenant: string;
        path: string;
        title: string;
        mime_type: string;
        ordinal: number;
        page_start: number | null;
        page_end: number | null;
        section: string | null;
        token_count: number;
        text: string;
        embedding: string | null;
        model: string | null;
      }[]
    >`
      SELECT o.slug AS tenant, doc.path, doc.title, doc.mime_type, c.ordinal, c.page_start, c.page_end, c.section,
        c.token_count, c.text, c.embedding::text AS embedding, c.embedding_model_version AS model
      FROM chunks c
      JOIN documents doc ON doc.id = c.document_id AND doc.version = c.document_version
      JOIN organization o ON o.id = c.tenant_id
      WHERE doc.status = 'ready'
      ORDER BY o.slug DESC, doc.path, c.ordinal`;
    const filing = rows.filter((row) => row.path === FILING);
    const chunks = rows.filter((row) => row.path !== FILING);
    if (filing.length === 0) throw new Error("the filing isn't in the dev database; ingest it first");
    const unembedded = chunks.filter((row) => row.embedding === null || row.model !== MODEL);
    if (unembedded.length) throw new Error(`${unembedded.length} chunks have no ${MODEL} embedding; run db:embed`);

    const cache: Record<string, number[]> = JSON.parse(readFileSync(CACHE, "utf8"));
    const key = (text: string) => createHash("sha256").update(`${MODEL}\n${text}`).digest("hex");
    const golden = loadGolden();
    const missing = golden.filter((q) => !cache[key(q.question)]);
    if (missing.length) throw new Error(`${missing.length} golden questions aren't cached; run vectors:bench`);
    const extra = EXTRA.filter((text) => !cache[key(text)]);
    if (extra.length) {
      const embedder = embedderFromEnv();
      if (embedder.version !== MODEL) throw new Error(`the extra queries need ${MODEL}; set OPENAI_API_KEY`);
      (await embedder.embed(extra)).forEach((vector, i) => (cache[key(extra[i])] = vector));
      writeFileSync(CACHE, JSON.stringify(cache));
    }
    const queries = [
      ...golden.map((q) => ({ id: q.id, tenant: q.tenant, user: q.user, question: q.question })),
      ...EXTRA.map((text) => ({ id: text.toLowerCase(), tenant: "kestrel", user: "leo.martin", question: text })),
    ];

    mkdirSync(OUT, { recursive: true });
    const header = {
      model: MODEL,
      dimensions: DIMENSIONS,
      recordedAt: new Date().toISOString().slice(0, 10),
      filing: { path: FILING, tokenCounts: filing.map((row) => row.token_count) },
    };
    const lines = chunks.map((row) =>
      JSON.stringify({
        tenant: row.tenant,
        path: row.path,
        title: row.title,
        mimeType: row.mime_type,
        ordinal: row.ordinal,
        pageStart: row.page_start,
        pageEnd: row.page_end,
        section: row.section,
        tokenCount: row.token_count,
        text: row.text,
      }),
    );
    // One chunk a line, so a re-recording diffs by chunk.
    writeFileSync(
      join(OUT, "chunks.json"),
      `${JSON.stringify(header).slice(0, -1)},"chunks":[\n${lines.join(",\n")}\n]}\n`,
    );
    writeFileSync(join(OUT, "chunks.f32"), f32(chunks.map((row) => JSON.parse(row.embedding!) as number[])));
    writeFileSync(join(OUT, "queries.json"), `[\n${queries.map((q) => JSON.stringify(q)).join(",\n")}\n]\n`);
    writeFileSync(join(OUT, "queries.f32"), f32(queries.map((q) => cache[key(q.question)])));
    process.stderr.write(
      `recorded ${chunks.length} chunks, ${filing.length} filing token counts, ${queries.length} queries\n`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
