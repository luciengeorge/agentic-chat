// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { Viewer } from "@/lib/auth-server";

vi.mock("@/lib/auth-server", () => ({ getViewer: vi.fn() }));

const { scopeOf, viewerFrom } = await import("./middleware");

const LEO: Viewer = {
  userId: "44444444-4444-4444-8444-444444444444",
  email: "leo.martin@kestrelpay.example",
  username: "leo.martin",
  name: "Leo Martin",
  tenant: { id: "11111111-1111-4111-8111-111111111111", slug: "kestrel" },
};

const request = (headers: HeadersInit = {}) => new Request("http://localhost:3000/api/chat", { headers });

describe("viewerFrom", () => {
  it("gives the viewer the session belongs to", async () => {
    expect(await viewerFrom(request({ cookie: "s=1" }), async () => LEO)).toBe(LEO);
  });

  it("answers getViewer's 401 or 403 instead of running the handler", async () => {
    for (const status of [401, 403]) {
      const answer = await viewerFrom(request(), async () => {
        throw Response.json({ error: "no" }, { status });
      });
      expect(answer).toBeInstanceOf(Response);
      expect((answer as Response).status).toBe(status);
    }
  });

  it("lets any other failure through as an error", async () => {
    await expect(
      viewerFrom(request(), async () => {
        throw new Error("database down");
      }),
    ).rejects.toThrow("database down");
  });
});

describe("scopeOf", () => {
  it("takes the tenant from the viewer's membership", () => {
    expect(scopeOf(LEO)).toEqual({ tenantId: LEO.tenant.id, userId: LEO.userId });
  });
});

// The boundary is only as good as its coverage, so check it: every chat server route and server function goes
// through viewerMiddleware, and none reads a tenant or user from what the client sent.
describe("the chat boundary", () => {
  const root = join(import.meta.dirname, "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.tsx?$/.test(name) && !name.includes(".test.") ? [path] : [];
    });
  const chatFiles = [...files(join(root, "routes/chat")), ...files(join(root, "routes/api/chat"))];
  const read = (path: string) => readFileSync(path, "utf8");

  it("puts every chat server route behind the middleware", () => {
    const routes = chatFiles.filter((path) => /\bserver:\s*\{/.test(read(path)));
    expect(routes.map((p) => relative(root, p)).sort()).toEqual([
      "routes/api/chat/documents.$documentId.ts",
      "routes/api/chat/index.ts",
    ]);
    for (const path of routes) expect(read(path)).toMatch(/server:\s*\{\s*middleware:\s*\[viewerMiddleware\]/);
  });

  it("puts every chat server function behind the middleware", () => {
    const sources = chatFiles.map(read).join("\n");
    const serverFns = sources.match(/createServerFn\([^)]*\)\s*\.\w+\([^)]*\)/g) ?? [];
    expect(serverFns.length).toBeGreaterThan(0);
    for (const call of serverFns) expect(call).toMatch(/\.middleware\(\[viewerMiddleware\]\)$/);
  });

  it("never takes a tenant or user id from a request schema", () => {
    for (const path of chatFiles) expect(read(path)).not.toMatch(/(tenantId|userId|tenant_id|user_id):\s*z\./);
  });
});
