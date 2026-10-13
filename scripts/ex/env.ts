import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/**
 * The environment `pnpm dev` and `pnpm fake-workspace` run with: this one over `.env.local`, as
 * dotenv-cli loads it for them. `ex` reads it too, so it finds what they use (the local world's
 * runs, the stack's URLs) however it was started.
 */
export function localEnv(root: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const file = join(root, ".env.local");
  return { ...(existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {}), ...env };
}
