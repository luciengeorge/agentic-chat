import { createServerFn } from "@tanstack/react-start";

/**
 * Whether Postgres isn't answering. A failed session lookup surfaces as better-auth's bare "Failed to get session",
 * and a loader's as whatever its query threw, so ask the database itself instead of reading the error.
 */
export async function databaseDown(ping: () => Promise<unknown>): Promise<boolean> {
  try {
    await ping();
    return false;
  } catch {
    return true;
  }
}

export interface DatabaseStatus {
  down: boolean;
  /** In dev the fix is on this machine, so the page can say what to run. */
  dev: boolean;
}

/** For the error page: is the database the reason? */
export const getDatabaseStatus = createServerFn({ method: "GET" }).handler(async (): Promise<DatabaseStatus> => {
  const [{ appDb }, { sql }, { acEnv }] = await Promise.all([
    import("@/db/pool"),
    import("drizzle-orm"),
    import("@/lib/env"),
  ]);
  return { down: await databaseDown(() => appDb().execute(sql`select 1`)), dev: acEnv() === "dev" };
});
