import { type SQL, sql } from "drizzle-orm";

/** A uuid[] literal built from parameters. Drizzle expands a bare JS array into a parameter list, not an array. */
export function uuidArray(ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`ARRAY[]::uuid[]`;
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
}
