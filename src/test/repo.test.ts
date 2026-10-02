// @vitest-environment node

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");

function ignored(path: string) {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: ROOT });
    return true;
  } catch {
    return false;
  }
}

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((path) => /\.tsx?$/.test(path))
    .map((path) => join(dir, path));
}

describe("the repo", () => {
  it("ignores every env file but the example", () => {
    for (const path of [".env", ".env.local", ".env.production", ".env.test", ".env.development.local"]) {
      expect(ignored(path), path).toBe(true);
    }
    expect(ignored(".env.example")).toBe(false);
  });

  it("documents in .env.example every VITE_ variable the app reads", () => {
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    const read = new Set(
      sources("src").flatMap((path) =>
        [...readFileSync(join(ROOT, path), "utf8").matchAll(/import\.meta\.env\.(VITE_\w+)/g)].map((m) => m[1]),
      ),
    );
    expect(read.size).toBeGreaterThan(0);
    for (const name of read) expect(example, name).toMatch(new RegExp(`^${name}=`, "m"));
  });

  it("serves every local file the root route links to", () => {
    const root = readFileSync(join(ROOT, "src/routes/__root.tsx"), "utf8");
    const hrefs = [...root.matchAll(/href: "(\/[^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(existsSync(join(ROOT, "public", href)), href).toBe(true);
  });
});
