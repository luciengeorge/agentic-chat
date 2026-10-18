// 👨‍💼 Kestrel's lexical index splits "KPC-2026-0142" into three terms, so a search for "2026" finds every contract.
//    A tokenizer that keeps identifiers whole fixes that. But changing a tokenizer means rebuilding the index, and
//    lexical search runs on every question: it can't go missing, or change its answers, while the rebuild happens.

import { sql } from "drizzle-orm";

import type { Db } from "@/db/create";
import type { Tx } from "@/db/tenant";

import { LEXICAL_FIELD } from "#learn/search/lexical";

/**
 * Changing the BM25 tokenizer without downtime, on pg_search 0.26. The building blocks are written: the DDL
 * (`fieldExpression`, `bm25IndexSql`), a concurrent build, the list of live indexes, and a drop-and-rename. You
 * write the order they go in, and the read that checks a change before anyone depends on it.
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
 * Starts a tokenizer change: afterwards the live index (`chunks_bm25_idx`) holds both `from` and `to`, and every
 * search on `from` answers exactly as before.
 */
export async function beginTokenizerChange(db: Db, from: LexicalField, to: LexicalField): Promise<void> {
  // 🐨 Refuse (RangeError) a `to` with the same name as `from`: the new field needs a name of its own.
  // 🐨 Put a transition index in the live index's place. When this returns, `chunks_bm25_idx` must hold `to` as
  //    well, and every search on `from` must answer exactly as it did before, scores included. Searches keep
  //    running the whole time, so work out which fields the new index needs and the order of the moves that keep
  //    lexical search answering at every moment.
  //
  // 💰 The moves are written, above: `replaceBm25Index` and `buildBm25IndexConcurrently` (each one's doc comment
  //    says what it takes). Build under `NEXT_BM25_INDEX`.
  //
  // 🦉 What pg_search allows (0.26.1). A table may have one ParadeDB index: a plain second `CREATE INDEX` fails
  //    with "a relation may only have one ParadeDB index". `CREATE INDEX CONCURRENTLY` is the exception, so an
  //    index can be rebuilt while the old one serves. The moment the new one is valid, every query on the table
  //    uses it, the newest, at once. So you can't keep two indexes and choose between them per query. Walk through
  //    what a search on `text` gets at each moment of your moves: while the build runs, the instant it's valid,
  //    and after each of the others. A test runs searches all the way through and tells you if one fails or
  //    changes; the solution README says why after you've tried.
  //
  // 📜 https://docs.paradedb.com/documentation/indexing/reindexing
  throw new Error(`beginTokenizerChange(${typeof db}, from ${from.name}, to ${to.name}) isn't written yet`);
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
 * Dual read: the same queries against two fields of the live index, with the same pre-filter, to see what a cutover
 * would change before it happens. Run it inside `withTenant`.
 */
export async function compareFields(
  tx: Tx,
  queries: string[],
  options: { from: string; to: string; documentIds: readonly string[]; limit: number },
): Promise<FieldComparison[]> {
  // 🐨 For each query, in order: run lexicalSearch on the `from` field and on the `to` field (same documents, same
  //    limit), keep the ids, and work out the overlap: the share of `from`'s ids that `to` also returned. If
  //    `from` found nothing, the overlap is 1 when `to` found nothing too, and 0 when it found something.
  //
  // 💰 Add `lexicalSearch` to the import from "#learn/search/lexical"; its `field` option picks the field.
  //    `hits.map((hit) => hit.id)`, `list.filter((id) => other.includes(id)).length`.
  //
  // 🦉 Why read both before switching. The transition index answers on both fields at no extra cost, so you can
  //    run the real questions people ask against both and see what would move: which chunks drop out, which come
  //    in. An overlap of 0.6 means 4 of the 10 results would change. That's the moment to look at them, not after
  //    the switch.
  // 🦉 Why share of `from`. The question is "what would people lose"; `from` is what they get today.
  //
  // 🚨 The tests check that beginning a change leaves every search on `text` exactly as it was and one index
  //    serving, that the new field keeps identifiers whole, that the dual read reports what each field returned and
  //    the overlap (1 for two empty lists), and the worked example over the recorded chunks.
  throw new Error(
    `compareFields(${typeof tx}, ${queries.length} queries, ${options.from} against ${options.to}) isn't written yet`,
  );
}
