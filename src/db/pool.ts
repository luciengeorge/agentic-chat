import { createDb, type Db } from "./create";

// One pool per URL for the whole process. In dev, step code loads this module once from Workflow's steps.mjs and
// once from the Vite graph, so a pool made at module scope would exist twice.
const REGISTRY = Symbol.for("agentic-chat.db");

function registry(): Map<string, Db> {
  const store = globalThis as typeof globalThis & { [REGISTRY]?: Map<string, Db> };
  return (store[REGISTRY] ??= new Map());
}

/** The process's pool for `url`, made on first use. */
export function dbFor(url: string): Db {
  let db = registry().get(url);
  if (!db) {
    db = createDb(url);
    registry().set(url, db);
  }
  return db;
}

/** Ends the pool for `url` and forgets it. */
export async function closeDb(url: string): Promise<void> {
  const db = registry().get(url);
  registry().delete(url);
  await db?.$client.end();
}

/** The app role (`ac_app`), which RLS binds. Tenant data only through `withTenant`. */
export function appDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  return dbFor(url);
}

/**
 * The owner, which bypasses RLS: only for work that crosses tenants on purpose (the outbox relay, the seed,
 * migrations, ex smoke). Named so every use stands out in review.
 */
export function systemDb(): Db {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL must be set for cross-tenant work");
  return dbFor(url);
}
