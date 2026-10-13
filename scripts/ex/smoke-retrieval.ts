import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Embedder } from "#learn/embed/embed";
import type { QueryRewriter } from "#learn/query/rewrite";
import type { Reranker } from "#learn/rerank/rerank";
import type { Retrieval } from "#learn/retrieve/types";

import { createRetrieve } from "#learn/retrieve/retrieve";
import { uuidArray } from "#learn/search/sql";
import { closeDb, dbFor } from "@/db/pool";
import { type Tx, withTenantOn } from "@/db/tenant";
import { loadWorld } from "@/fixtures/world";
import { embedderFromEnv, rerankerFromEnv, rewriterFromEnv } from "@/lib/retrieval.server";

import type { SmokeTargets } from "./smoke";

type Manifest = { sites: Record<string, { items: { id: string; path: string; traps?: string[] }[] }> };

export interface RetrievalDeps {
  embedder: Embedder;
  reranker: Reranker;
  rewriter: QueryRewriter;
}

const CONTRACT = "KPC-2026-0142";
const ERROR_CODE = "KP-4031";

/**
 * 8. Retrieval, against the live database and the configured models, as `retrieve()` runs in the app: every live
 * chunk has an embedding from the current model; the Heron memo reaches daniel.reyes and never leo.martin; a
 * contract number and an error code come back first; a Harbour user gets only Harbour chunks; peter.hall, disabled,
 * gets nothing; each call wrote its audit row.
 */
export async function checkRetrieval(target: SmokeTargets, given?: RetrievalDeps): Promise<string> {
  const world = loadWorld();
  const manifest = JSON.parse(readFileSync(join(target.corpusDir, "manifest.json"), "utf8")) as Manifest;
  const [memo] = manifest.sites.kestrel?.items.filter((item) => item.traps?.includes("acl-leak")) ?? [];
  if (!memo) throw new Error("the manifest has no acl-leak document");

  const db = dbFor(target.databaseUrl);
  try {
    const tenants = new Map<string, string>();
    for (const site of ["kestrel", "harbour"]) {
      let row: { id: string } | undefined;
      try {
        [row] = await db.$client<{ id: string }[]>`SELECT id FROM organization WHERE slug = ${site}`;
      } catch (error) {
        if ((error as { code?: string }).code !== "ECONNREFUSED") throw error;
        throw new Error(`nothing answers at ${new URL(target.databaseUrl).host}; \`pnpm ex up\` starts ParadeDB`);
      }
      if (!row) throw new Error(`no ${site} organization; run \`pnpm db:seed\``);
      tenants.set(site, row.id);
    }
    const deps = given ?? { embedder: embedderFromEnv(), reranker: rerankerFromEnv(), rewriter: rewriterFromEnv() };
    const withTenant = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => withTenantOn(db, tenantId, fn);
    const retrieve = createRetrieve({ withTenant, ...deps });
    const ask = (site: string, username: string, query: string): Promise<Retrieval> =>
      retrieve({ tenantId: tenants.get(site)!, userId: world.userId(site, username) }, query);

    for (const [site, tenantId] of tenants) {
      const [{ stale, total }] = await withTenant(tenantId, (tx) =>
        tx.execute<{ stale: number; total: number }>(sql`
          SELECT count(*) FILTER (
              WHERE c.embedding IS NULL OR c.embedding_model_version <> ${deps.embedder.version})::int AS stale,
            count(*)::int AS total
          FROM chunks c JOIN documents d ON d.id = c.document_id AND d.version = c.document_version
          WHERE d.status = 'ready'`),
      );
      if (total === 0) throw new Error(`${site}: no chunks; is ingestion done?`);
      if (stale > 0) {
        throw new Error(
          `${site}: ${stale} of ${total} chunks lack a ${deps.embedder.version} embedding; run \`pnpm db:embed\``,
        );
      }
    }

    const heron = "What is Project Heron, and when does the board vote on it?";
    const leo = await ask("kestrel", "leo.martin", heron);
    if (leo.chunks.some((chunk) => chunk.path === memo.path)) throw new Error(`leo.martin was given ${memo.path}`);
    if (leo.chunks.some((chunk) => chunk.path.startsWith("/Exec/"))) {
      throw new Error(`leo.martin was given an /Exec document: ${leo.chunks.map((chunk) => chunk.path).join(", ")}`);
    }
    const daniel = await ask("kestrel", "daniel.reyes", heron);
    if (!daniel.chunks.some((chunk) => chunk.path === memo.path))
      throw new Error(`daniel.reyes didn't get ${memo.path}`);

    const contract = await ask("kestrel", "leo.martin", `What are the payment terms in contract ${CONTRACT}?`);
    if (!contract.chunks[0]?.text.includes(CONTRACT)) {
      throw new Error(`${CONTRACT} isn't in the first chunk (${contract.chunks[0]?.path ?? "none"})`);
    }
    const code = await ask("kestrel", "sam.patel", `What does error ${ERROR_CODE} mean?`);
    if (!code.chunks[0]?.text.includes(ERROR_CODE)) {
      throw new Error(`${ERROR_CODE} isn't in the first chunk (${code.chunks[0]?.path ?? "none"})`);
    }

    const nina = await ask("harbour", "nina.osei", "What is the nightly hotel limit in the expenses policy?");
    const harbourIds = new Set(
      (
        await withTenant(tenants.get("harbour")!, (tx) => tx.execute<{ id: string }>(sql`SELECT id FROM documents`))
      ).map((row) => row.id),
    );
    if (nina.chunks.length === 0) throw new Error("nina.osei got nothing about Harbour's expenses");
    const foreign = nina.chunks.filter((chunk) => !harbourIds.has(chunk.documentId));
    if (foreign.length) throw new Error(`nina.osei was given ${foreign.map((chunk) => chunk.path).join(", ")}`);

    const peter = await ask("kestrel", "peter.hall", "What are the FY2026 budget assumptions?");
    if (peter.chunks.length > 0) throw new Error(`peter.hall, disabled, was given ${peter.chunks.length} chunks`);

    const retrievals = [leo, daniel, contract, code, nina, peter];
    const audits = new Set<string>();
    for (const [site, tenantId] of tenants) {
      const rows = await withTenant(tenantId, (tx) =>
        tx.execute<{ id: string }>(
          sql`SELECT id FROM retrieval_audit WHERE id = ANY(${uuidArray(retrievals.map((retrieval) => retrieval.auditId))})`,
        ),
      );
      for (const row of rows) audits.add(`${site}:${row.id}`);
    }
    if (audits.size !== retrievals.length) {
      throw new Error(`${audits.size} of ${retrievals.length} retrievals have an audit row`);
    }

    return (
      `${deps.embedder.version}, ${deps.reranker.name}; Heron memo: daniel.reyes yes, leo.martin no; ` +
      `${CONTRACT} and ${ERROR_CODE} first; nina.osei Harbour only; peter.hall nothing; ${audits.size} audit rows`
    );
  } finally {
    await closeDb(target.databaseUrl);
  }
}
