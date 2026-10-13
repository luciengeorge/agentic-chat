import type postgres from "postgres";

/** One sorted line per schema object in `public`, so two databases compare as sets of strings. */
export async function catalog(sql: postgres.Sql): Promise<string[]> {
  const queries = [
    sql`SELECT 'extension ' || extname AS line FROM pg_extension`,
    sql`SELECT format('table %s rls=%s forced=%s', c.relname, c.relrowsecurity, c.relforcerowsecurity) AS line
        FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'`,
    sql`SELECT format('column %s.%s %s notnull=%s default=%s', c.relname, a.attname,
          format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid)) AS line
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`,
    sql`SELECT format('constraint %s.%s %s', conrelid::regclass, conname, pg_get_constraintdef(oid)) AS line
        FROM pg_constraint WHERE connamespace = 'public'::regnamespace`,
    sql`SELECT 'index ' || indexdef AS line FROM pg_indexes WHERE schemaname = 'public'`,
    sql`SELECT format('sequence %s %s start=%s min=%s max=%s inc=%s cycle=%s cache=%s', sequencename, data_type,
          start_value, min_value, max_value, increment_by, cycle, cache_size) AS line
        FROM pg_sequences WHERE schemaname = 'public'`,
    sql`SELECT format('policy %s.%s %s %s to=%s using=%s check=%s', tablename, policyname, permissive, cmd,
          roles, qual, with_check) AS line
        FROM pg_policies WHERE schemaname = 'public'`,
    sql`SELECT 'trigger ' || pg_get_triggerdef(oid) AS line FROM pg_trigger WHERE NOT tgisinternal`,
  ];
  const results = await Promise.all(queries);
  return results.flatMap((rows) => rows.map((row) => row.line as string)).sort();
}
