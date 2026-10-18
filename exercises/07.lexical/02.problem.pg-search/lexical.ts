// 👨‍💼 This is the lexical half of every search the assistant runs, over pg_search's BM25 index on `chunks.text`.
//    It has to rank like the BM25 you wrote, read the words the way the index cut them, and never return a chunk
//    of a document the viewer can't read.

import { type SQL, sql } from "drizzle-orm";

import type { Tx } from "@/db/tenant";

export interface Hit {
  id: string;
  score: number;
}

/**
 * BM25 over `chunks.text` through pg_search's index (`chunks_bm25_idx`): the chunks of `documentIds` that hold
 * any of the query's terms, best first. Run it inside `withTenant`.
 */
export async function lexicalSearch(
  tx: Tx,
  query: string,
  options: {
    documentIds: readonly string[];
    limit: number;
    /** Which of the index's fields over `text` to search: `text` itself (the default), or an alias the index
     * declares with another tokenizer (see `#learn/search/reindex`). */
    field?: string;
  },
): Promise<Hit[]> {
  if (options.documentIds.length === 0 || query.trim() === "") return [];
  // 🐨 One query on `chunks`: rows whose text field matches any term of `query` (pg_search's `|||`), and whose
  //    `document_id` is in `documentIds`. Return each row's id and its BM25 score, best first, ties broken by id,
  //    at most `limit` of them. Use `textField(options.field)` for the field, so step 4 can point it elsewhere.
  //
  // 💰 Add `import { uuidArray } from "#learn/search/sql"`. In a `sql` template, `${query}` is a parameter, so
  //    the text is never read as SQL: `WHERE ${textField(options.field)} ||| ${query}`. `pdb.score(id)` is the
  //    BM25 score of the row being read. `document_id = ANY(${uuidArray(ids)})`. Scores may come back as strings:
  //    `Number(row.score)`.
  //
  // 🦉 What the index did to the words. `chunks_bm25_idx` reads `text` with the `unicode_words` tokenizer,
  //    English stemming and English stopwords (migration `m1_search_indexes`). `|||` puts the query through the same
  //    tokenizer, so "nightly" and "nights" both become "night", and "is", "the", "for", "a" and "in" vanish.
  //    That's why ILIKE '%nights%' is the wrong tool: it compares letters, finds "nights" but not "night", and
  //    can't rank at all.
  // 🦉 Why any term, not all. `|||` is OR: a chunk with "hotel" and "london" but not "limit" still comes back,
  //    just lower. `&&&` (AND) would drop every chunk that lacks one word of a long question, and long questions
  //    are what people type.
  // 🦉 Why the pre-filter is a WHERE clause. `document_id = ANY(...)` is the ACL pre-filter (section 09) and the
  //    tenant's RLS policy applies too. pg_search pushes both into the index scan, so a chunk the viewer can't
  //    read is never scored, never counted, never returned. Leave it out and search becomes a leak.
  // 🦉 Why break ties by id. Two chunks with the same text get the same score (the expenses policy's limits table
  //    is word for word the same in versions 1 and 2). Without a tie-break their order can change between runs,
  //    and so can which one makes the cut at `limit`.
  // 🦉 New in this file, already written: the early return (pg_search refuses an empty query) and `textField`.
  //
  // 📜 https://docs.paradedb.com/documentation/full-text/match (the `|||` and `&&&` operators)
  // 📜 https://docs.paradedb.com/documentation/sorting/score (pdb.score)
  //
  // 🚨 The tests check that the hotel question ranks the expenses policy's chunks by BM25, that any one of the
  //    query's words is enough, that "nights" finds what "night" finds, that a quote or a bracket in the query is
  //    just text, that only chunks of the listed documents come back, and that ties come back in id order.
  throw new Error(`lexicalSearch(${typeof tx}, "${query}", ${options.documentIds.length} documents) isn't written yet`);
}

/** The column itself is the index's `text` field; any other name is an alias, selected with `pdb.alias`. */
export const LEXICAL_FIELD = "text";

const FIELD_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function textField(field: string = LEXICAL_FIELD): SQL {
  if (!FIELD_NAME.test(field)) throw new RangeError(`not a field name: ${JSON.stringify(field)}`);
  return field === LEXICAL_FIELD ? sql`text` : sql.raw(`(text::pdb.alias('${field}'))`);
}
