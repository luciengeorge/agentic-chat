import { sql } from "drizzle-orm";

import type { Db } from "@/db/create";
import type { Tx } from "@/db/tenant";

import { LEXICAL_FIELD, lexicalSearch } from "#learn/search/lexical";

/**
 * Changing the BM25 tokenizer without downtime, on pg_search 0.26.
 *
 * What pg_search allows (checked against 0.26.1, and its docs' "Reindexing" page):
 * - One ParadeDB index per table. A plain `CREATE INDEX` of a second one fails: "a relation may only have one
 *   ParadeDB index". `CREATE INDEX CONCURRENTLY` is the exception, so an index can be rebuilt in the background.
 * - Once the concurrent build is valid, every query on the table uses the newest index, at once. A query on `text`
 *   goes to whatever the new index has for that column: if it only has an alias with another tokenizer, the old
 *   query silently gets the new tokenizer. So two indexes can't be read side by side.
 * - One index may hold one column several times, each with its own tokenizer, under an alias
 *   (`text::pdb.regex_pattern(..., 'alias=text_v2')`), queried as `text::pdb.alias('text_v2') ||| ...`.
 *
 * So the pattern is a transition index that carries both tokenizations:
 * 1. build it concurrently: the old field exactly as before (same name, same tokenizer), plus the new one under an
 *    alias. While it builds, the old index serves; once it's valid it serves, and the old field answers the same;
 * 2. drop the old index (concurrently) and rename the new one to the old name;
 * 3. dual-read: run real queries against both fields and compare the rankings;
 * 4. cut over by changing the field retrieval searches (`lexicalField` in retrieve's settings). Rolling back is
 *    the same switch, while the old field is still in the index;
 * 5. later, rebuild with the new field alone, and drop the transition index.
 *
 * Embeddings have the same problem with a different shape: `chunks.embedding_model_version` says which model made
 * each vector, and search compares only same-version vectors. One column holds one version, so a zero-downtime
 * model change needs a second column and HNSW index (pgvector allows several), filled before the switch.
 */

export interface Tokenizer {
  /** A pg_search tokenizer type, without `pdb.`: `unicode_words`, `simple`, `regex_pattern`, ... */
  name: string;
  /** Its arguments as pg_search takes them, e.g. `stemmer=english`; a regex pattern comes first. */
  args: string[];
}

export interface LexicalField {
  /** `text` for the column's own field; anything else is an alias. */
  name: string;
  tokenizer: Tokenizer;
}

/** The field `chunks_bm25_idx` has today (migration `m1_search_indexes`). */
export const LEXICAL_V1: LexicalField = {
  name: LEXICAL_FIELD,
  tokenizer: { name: "unicode_words", args: ["stemmer=english", "stopwords_language=english"] },
};

/** An example change: identifiers stay whole ("KPC-2026-0142" is one token, so "2026" no longer matches it). */
export const LEXICAL_V2: LexicalField = {
  name: "text_v2",
  tokenizer: {
    name: "regex_pattern",
    args: ["[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*", "stemmer=english", "stopwords_language=english"],
  },
};

export const BM25_INDEX = "chunks_bm25_idx";

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new RangeError(`not an identifier: ${JSON.stringify(name)}`);
  return name;
}

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** One indexed expression: `(text::pdb.<tokenizer>(<args>, 'alias=<name>'))`. */
export function fieldExpression(field: LexicalField): string {
  const args = [...field.tokenizer.args];
  if (field.name !== LEXICAL_FIELD) args.push(`alias=${identifier(field.name)}`);
  const call = args.length ? `(${args.map(literal).join(",")})` : "";
  return `(text::pdb.${identifier(field.tokenizer.name)}${call})`;
}

/** The BM25 index over chunks with these text fields. `tenant_id` and `document_id` ride along, as in the app's. */
export function bm25IndexSql(name: string, fields: LexicalField[], { concurrently = true } = {}): string {
  if (fields.length === 0) throw new RangeError("an index needs at least one text field");
  const names = fields.map((field) => field.name);
  if (new Set(names).size !== names.length) throw new RangeError(`field names repeat: ${names.join(", ")}`);
  return (
    `CREATE INDEX ${concurrently ? "CONCURRENTLY " : ""}${identifier(name)} ON chunks USING paradedb ` +
    `(id, ${fields.map(fieldExpression).join(", ")}, tenant_id, document_id)`
  );
}

/**
 * Builds a BM25 index in the background while the current one serves. `CONCURRENTLY` can't run in a transaction,
 * so this takes the pool, as the owner. A failed concurrent build leaves an invalid index behind; it's dropped.
 */
export async function buildBm25IndexConcurrently(db: Db, name: string, fields: LexicalField[]): Promise<void> {
  try {
    await db.execute(sql.raw(bm25IndexSql(name, fields)));
  } catch (error) {
    await db.execute(sql.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${identifier(name)}`));
    throw error;
  }
  const [row] = await db.execute<{ valid: boolean }>(
    sql`SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass(${name})`,
  );
  if (!row?.valid) throw new Error(`${name} did not build`);
}

/** The ParadeDB indexes on chunks, oldest first. pg_search queries the last one. */
export async function bm25Indexes(db: Db): Promise<string[]> {
  const rows = await db.execute<{ name: string }>(sql`
    SELECT c.relname AS name
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_am am ON am.oid = c.relam
    WHERE i.indrelid = 'chunks'::regclass AND am.amname = 'paradedb' AND i.indisvalid
    ORDER BY c.oid`);
  return rows.map((row) => row.name);
}

/** Drops an index without blocking writes, then gives the new one the old one's name. */
export async function replaceBm25Index(db: Db, oldName: string, newName: string): Promise<void> {
  await db.execute(sql.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${identifier(oldName)}`));
  await db.execute(sql.raw(`ALTER INDEX ${identifier(newName)} RENAME TO ${identifier(oldName)}`));
}

/** The name the next index builds under, while `chunks_bm25_idx` still serves. */
export const NEXT_BM25_INDEX = "chunks_bm25_next";

/**
 * Steps 1 and 2: build the transition index (the old field exactly as it is, plus the new one under its alias)
 * beside the live index, then put it in the live index's place. No query changes its answer: `from` is indexed as
 * before, and the switch to `to` is a separate decision (step 4).
 */
export async function beginTokenizerChange(db: Db, from: LexicalField, to: LexicalField): Promise<void> {
  if (from.name === to.name) throw new RangeError(`the new field needs a name of its own, not ${from.name}`);
  await buildBm25IndexConcurrently(db, NEXT_BM25_INDEX, [from, to]);
  await replaceBm25Index(db, BM25_INDEX, NEXT_BM25_INDEX);
}

/** Step 5: once nothing searches the old field, an index with the new field alone takes over. */
export async function finishTokenizerChange(db: Db, to: LexicalField): Promise<void> {
  await buildBm25IndexConcurrently(db, NEXT_BM25_INDEX, [to]);
  await replaceBm25Index(db, BM25_INDEX, NEXT_BM25_INDEX);
}

export interface FieldComparison {
  query: string;
  from: string[];
  to: string[];
  /** The share of `from`'s top ids that `to` also returns (1 when `from` is empty and `to` is too). */
  overlap: number;
}

/**
 * Dual read: the same queries against two fields of the live index, with the same pre-filter, to see what a
 * cutover would change before it happens. Run it inside `withTenant`.
 */
export async function compareFields(
  tx: Tx,
  queries: string[],
  options: { from: string; to: string; documentIds: readonly string[]; limit: number },
): Promise<FieldComparison[]> {
  const out: FieldComparison[] = [];
  for (const query of queries) {
    const search = (field: string) =>
      lexicalSearch(tx, query, { documentIds: options.documentIds, limit: options.limit, field });
    const from = (await search(options.from)).map((hit) => hit.id);
    const to = (await search(options.to)).map((hit) => hit.id);
    const shared = from.filter((id) => to.includes(id)).length;
    out.push({ query, from, to, overlap: from.length === 0 ? (to.length === 0 ? 1 : 0) : shared / from.length });
  }
  return out;
}
