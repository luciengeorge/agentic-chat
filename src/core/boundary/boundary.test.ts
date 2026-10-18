// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileForBrowser } from "./testing";

const root = process.cwd();
const SERVER_ONLY = ["@/lib/auth-server", "@/lib/auth", "@/db/client", "@/db/pool", "@/db/tenant", "postgres"];

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !name.includes(".test.") ? [path] : [];
  });

describe("the browser build of the boundary", () => {
  it("keeps the auth code and the database out of the middleware's browser bundle", async () => {
    for (const path of ["src/core/boundary/middleware.ts", "src/lib/middleware.ts"]) {
      const { imports } = await compileForBrowser(readFileSync(join(root, path), "utf8"), join(root, path));
      expect(
        imports.filter((i) => SERVER_ONLY.includes(i)),
        path,
      ).toEqual([]);
    }
  });

  it("would keep getViewer if the middleware referenced it outside .server()", async () => {
    const path = join(root, "src/core/boundary/middleware.ts");
    const trap = readFileSync(path, "utf8").replace(
      "export const viewerMiddleware",
      "export const loadViewer = getViewer;\nexport const viewerMiddleware",
    );
    expect((await compileForBrowser(trap, path)).imports).toContain("@/lib/auth-server");
  });

  it("puts every server route and server function in src/routes that acts for a user behind it", () => {
    for (const path of files(join(root, "src/routes"))) {
      const source = readFileSync(path, "utf8");
      if (!source.includes("viewerMiddleware")) continue;
      for (const call of source.match(/createServerFn\([^)]*\)\s*\.\w+\([^)]*\)/g) ?? []) {
        expect(call, path).toMatch(/\.middleware\(\[viewerMiddleware\]\)$/);
      }
    }
  });
});
