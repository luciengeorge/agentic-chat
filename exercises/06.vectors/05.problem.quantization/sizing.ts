// 👨‍💼 Kestrel's vectors take 6 KB each, and the index has to sit in memory to be fast. Every chunk the filing
//    adds is 6 KB more. Before buying a bigger database, count what a vector costs, and what each smaller form
//    gives back.

import { sql } from "drizzle-orm";

import type { Db } from "@/db/create";

/** The bytes one stored value of this type takes, header included. */
export function bytesPerVector(type: "vector" | "halfvec" | "bit", dimensions: number): number {
  // 🐨 Every value starts with an 8-byte header. Then `vector` stores each dimension as a 4-byte float, `halfvec`
  //    as a 2-byte float, and `bit` as one bit, rounded up to whole bytes.
  //
  // 💰 `Math.ceil(dimensions / 8)`.
  //
  // 🦉 What the header is. Postgres stores a variable-length value with a 4-byte length word in front (a
  //    "varlena"), and pgvector adds its own 4 bytes, the dimension count (2 bytes) and 2 unused. A bit string's
  //    header is the length word plus a 4-byte count of bits. So 1,536 dimensions are 8 + 6,144 = 6,152 bytes as
  //    `vector`. (A value under 127 bytes may get a 1-byte length word instead; at these sizes none does.)
  // 🦉 Why bytes decide the index's size. Postgres keeps rows and index entries in 8 KB pages, and an HNSW
  //    entry (the vector plus its links) can't be split across pages. A 6,152-byte vector leaves too little room
  //    for a second, so every vector(1536) takes a page of its own: 5,637 vectors make a 44 MB index whatever m
  //    is. At 3,080 bytes, halfvec fits two a page, 22 MB. At 200, bits fit dozens.
  //
  // 📜 https://github.com/pgvector/pgvector#vector-type (storage)
  //
  // 🚨 The tests check the sizes against what Postgres reports for the recorded vectors.
  throw new Error(`bytesPerVector(${type}, ${dimensions}) isn't written yet`);
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
