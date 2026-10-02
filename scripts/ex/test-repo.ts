import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Fetch } from "./smoke";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PLUGIN = join(REPO, "vite-plugins/learn-slots.ts");

export const VITEST_CONFIG = `import { learnSlots } from ${JSON.stringify(PLUGIN)};

export default { plugins: [learnSlots()], test: { environment: "node" } };
`;

/**
 * A throwaway repo for tests: the given files, plus a vitest.config.ts using learn-slots and a link
 * to this repo's node_modules, so Vitest can run in it. `cleanup()` deletes it.
 */
export function makeRepo(files: Record<string, string>): { root: string; cleanup(): void } {
  // realpath: macOS's tmpdir is a symlink, and Vitest reports real paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ex-repo-")));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  for (const [path, text] of Object.entries({
    "package.json": '{ "type": "module" }\n',
    "vitest.config.ts": VITEST_CONFIG,
    ...files,
  })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A step's README frontmatter. */
export function readme(meta: Record<string, string | boolean | Record<string, string>>): string {
  const lines = Object.entries(meta).flatMap(([key, value]) =>
    typeof value === "object"
      ? [`${key}:`, ...Object.entries(value).map(([k, v]) => `  ${k}: ${v}`)]
      : [`${key}: ${String(value)}`],
  );
  return ["---", ...lines, "---", ""].join("\n");
}

/** Vitest's own variables, which would confuse a Vitest started from inside a test. */
export function envWithoutVitest(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST"))),
    ...extra,
  };
}

/** What `fetch` throws when nothing listens on the port. */
export const refused: Fetch = async () => {
  const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  throw new TypeError("fetch failed", { cause });
};
