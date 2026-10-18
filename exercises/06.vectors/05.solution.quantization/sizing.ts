import { sql } from "drizzle-orm";

import type { Db } from "@/db/create";

/**
 * The bytes one value takes, header included (8 bytes: the varlena length word, then the dimension count).
 * `vector` stores 4-byte floats, `halfvec` 2-byte floats, `bit` one bit per dimension. (A value under 127 bytes
 * may be stored with a 1-byte length word instead of 4; at 1,536 dimensions none is.)
 */
export function bytesPerVector(type: "vector" | "halfvec" | "bit", dimensions: number): number {
  if (type === "vector") return 8 + 4 * dimensions;
  if (type === "halfvec") return 8 + 2 * dimensions;
  return 8 + Math.ceil(dimensions / 8);
}

/** The on-disk size of a table or index (its main fork), from `pg_relation_size`. */
export async function relationBytes(db: Db, name: string): Promise<number> {
  const [row] = await db.execute<{ bytes: string }>(sql`SELECT pg_relation_size(${name}::regclass) AS bytes`);
  return Number(row.bytes);
}

/** A table's size with its TOAST storage (where values over about 2 KB go), without its indexes: `pg_table_size`. */
export async function tableBytes(db: Db, name: string): Promise<number> {
  const [row] = await db.execute<{ bytes: string }>(sql`SELECT pg_table_size(${name}::regclass) AS bytes`);
  return Number(row.bytes);
}
