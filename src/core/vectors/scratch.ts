import { sql } from "drizzle-orm";

import type { Db } from "@/db/create";

import { identifier, vectorLiteral } from "./sql";
import { truncateEmbedding } from "./truncate";

/**
 * A scratch table for vector experiments, beside (never inside) the app's tables. Each row holds one embedding in
 * every form the experiments compare: full (`embedding`), half precision (`half`), binary (`bits`) and one
 * truncated column per prefix length (`e256`, `e512`, ...).
 */
export interface ScratchTable {
  name: string;
  dimensions: number;
  truncations: number[];
}

export const truncatedColumn = (dimensions: number) => `e${dimensions}`;

export async function createScratchTable(db: Db, table: ScratchTable): Promise<void> {
  const d = table.dimensions;
  const truncated = table.truncations.map((n) => `, ${truncatedColumn(n)} vector(${n}) NOT NULL`).join("");
  await db.execute(sql.raw(`DROP TABLE IF EXISTS ${identifier(table.name)}`));
  await db.execute(
    sql.raw(
      `CREATE TABLE ${identifier(table.name)} (id text PRIMARY KEY, embedding vector(${d}) NOT NULL, ` +
        `half halfvec(${d}) NOT NULL, bits bit(${d}) NOT NULL${truncated})`,
    ),
  );
}

/** Inserts rows; `half` and `bits` are pgvector's casts of the full vector, the prefixes are `truncateEmbedding`. */
export async function loadScratchTable(
  db: Db,
  table: ScratchTable,
  rows: { id: string; embedding: readonly number[] }[],
  batchSize = 200,
): Promise<void> {
  const d = table.dimensions;
  const columns = ["id", "embedding", "half", "bits", ...table.truncations.map(truncatedColumn)].join(", ");
  for (let i = 0; i < rows.length; i += batchSize) {
    const values = rows.slice(i, i + batchSize).map((row) => {
      const full = sql`${vectorLiteral(row.embedding)}::vector(${sql.raw(String(d))})`;
      const prefixes = table.truncations.map(
        (n) => sql`, ${vectorLiteral(truncateEmbedding(row.embedding, n))}::vector(${sql.raw(String(n))})`,
      );
      return sql`(${row.id}, ${full}, ${full}::halfvec(${sql.raw(String(d))}), binary_quantize(${full})::bit(${sql.raw(String(d))})${sql.join(prefixes, sql``)})`;
    });
    await db.execute(
      sql`INSERT INTO ${sql.raw(identifier(table.name))} (${sql.raw(columns)}) VALUES ${sql.join(values, sql`, `)}`,
    );
  }
  await db.execute(sql.raw(`ANALYZE ${identifier(table.name)}`));
}
