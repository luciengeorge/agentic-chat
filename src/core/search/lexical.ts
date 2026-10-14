import { type SQL, sql } from "drizzle-orm";

import type { Tx } from "@/db/tenant";

import { uuidArray } from "./sql";

export interface Hit {
  id: string;
  score: number;
}

/**
 * BM25 over `chunks.text` through pg_search's index (`chunks_bm25_idx`). `|||` matches any of the query's terms,
 * tokenized as the index tokenizes the text, and `pdb.score` ranks by BM25, so a rare term such as a contract number
 * outweighs common ones. The query is text, never query syntax, so it needs no escaping.
 *
 * Only chunks of `documentIds` come back: the ACL pre-filter, pushed into the index with the tenant's RLS policy.
 * Run it inside `withTenant`: outside it, the policy's tenant is NULL and pg_search refuses the query.
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
  const rows = await tx.execute<{ id: string; score: number }>(sql`
    SELECT id, pdb.score(id) AS score
    FROM chunks
    WHERE ${textField(options.field)} ||| ${query} AND document_id = ANY(${uuidArray(options.documentIds)})
    ORDER BY pdb.score(id) DESC, id
    LIMIT ${options.limit}`);
  return rows.map((row) => ({ id: row.id, score: Number(row.score) }));
}

/** The column itself is the index's `text` field; any other name is an alias, selected with `pdb.alias`. */
export const LEXICAL_FIELD = "text";

const FIELD_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function textField(field: string = LEXICAL_FIELD): SQL {
  if (!FIELD_NAME.test(field)) throw new RangeError(`not a field name: ${JSON.stringify(field)}`);
  return field === LEXICAL_FIELD ? sql`text` : sql.raw(`(text::pdb.alias('${field}'))`);
}
