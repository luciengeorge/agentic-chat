// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Viewer } from "@/lib/auth-server";

import { compileForBrowser } from "@/core/boundary/testing";

vi.mock("@/lib/auth-server", () => ({ getViewer: vi.fn() }));

const { getViewer } = await import("@/lib/auth-server");
const { scopeOf, viewerFrom, viewerMiddleware } = await import("#learn/boundary/middleware");
const load = vi.mocked(getViewer);

const LEO: Viewer = {
  userId: "5b6c2a8e-0d0e-5f39-9a4c-9b0c1b6f0e11",
  email: "leo.martin@kestrelpay.example",
  username: "leo.martin",
  name: "Leo Martin",
  tenant: { id: "11111111-1111-4111-8111-111111111111", slug: "kestrel" },
};

const request = (cookie = "better-auth.session_token=leo") =>
  new Request("http://localhost:3000/api/chat", { method: "POST", headers: { cookie } });

/** Runs the middleware's server function the way TanStack Start does, with a handler that records it ran. */
async function through(req: Request) {
  const server = viewerMiddleware.options.server;
  if (!server) throw new Error("viewerMiddleware has no .server(): build it with createMiddleware().server(...)");
  const ran: unknown[] = [];
  const next = vi.fn(async (options?: { context?: unknown }) => {
    ran.push(options?.context);
    return { request: req, pathname: "/api/chat", context: options?.context, response: new Response("answer") };
  });
  const result = await server({
    request: req,
    pathname: "/api/chat",
    context: {},
    next,
    handlerType: "router",
  } as never);
  return { result, next, ran };
}

const root = process.cwd();
const slotFile = join(process.env.AC_SLOT_ROOT ?? join(root, "playground"), "middleware.ts");

// A block, not an arrow that returns the mock: Vitest would call a returned function after each test.
beforeEach(() => {
  load.mockReset();
});

describe("viewerFrom", () => {
  it("gives the viewer the request's session belongs to, from the request's own headers", async () => {
    const req = request();
    const seen: Headers[] = [];
    expect(await viewerFrom(req, async (headers) => (seen.push(headers), LEO))).toBe(LEO);
    expect(seen[0]?.get("cookie"), "pass request.headers: they carry the cookie").toBe("better-auth.session_token=leo");
  });

  it("returns the 401 or 403 the loader throws, as the answer to send", async () => {
    for (const status of [401, 403]) {
      const answer = await viewerFrom(request(), async () => {
        throw Response.json({ error: "no" }, { status });
      });
      expect(answer, "a thrown Response is the answer: return it, don't throw it on").toBeInstanceOf(Response);
      expect((answer as Response).status).toBe(status);
    }
  });

  it("lets any other failure through as an error", async () => {
    await expect(
      viewerFrom(request(), async () => {
        throw new Error("database down");
      }),
      "only a Response is an answer; a broken database is a 500, not a refusal",
    ).rejects.toThrow("database down");
  });
});

describe("viewerMiddleware", () => {
  it("puts the viewer in the context and runs the handler", async () => {
    load.mockResolvedValue(LEO);
    const req = request();
    const { result, ran } = await through(req);
    expect(ran, "call next({ context: { viewer } }) once").toEqual([{ viewer: LEO }]);
    expect((result as { response: Response }).response, "return what next returns").toBeInstanceOf(Response);
    expect(load.mock.calls[0]?.[0], "getViewer gets this request's headers").toBe(req.headers);
  });

  it("answers 401 or 403 itself, and the handler never runs", async () => {
    for (const status of [401, 403]) {
      load.mockImplementationOnce(async () => {
        throw Response.json({ error: "unauthorized" }, { status });
      });
      const { result, next } = await through(request(""));
      expect(next, "a refusal stops here: don't call next").not.toHaveBeenCalled();
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(status);
    }
  });

  it("lets a failure through instead of running the handler", async () => {
    load.mockImplementation(async () => {
      throw new Error("database down");
    });
    const outcome = await through(request()).then(
      ({ ran }) => `the handler ran with ${JSON.stringify(ran)}`,
      (error: unknown) => (error as Error).message,
    );
    expect(outcome, "a failure that isn't a Response gets through as an error").toBe("database down");
  });

  it("gives retrieval the tenant from the viewer", () => {
    expect(scopeOf(LEO)).toEqual({ tenantId: LEO.tenant.id, userId: LEO.userId });
  });
});

describe("the browser build", () => {
  it("keeps the auth code and the database out of the browser bundle", async () => {
    const { imports } = await compileForBrowser(readFileSync(slotFile, "utf8"), slotFile);
    expect(
      imports,
      "compiled for the browser, your file still imports @/lib/auth-server: getViewer is referenced outside " +
        ".server() somewhere the compiler can't drop (an export, a default parameter, a helper)",
    ).not.toContain("@/lib/auth-server");
  });

  it("compiles to a middleware with no server code: one import, and every user-facing route behind it", async () => {
    const { imports, code } = await compileForBrowser(readFileSync(slotFile, "utf8"), slotFile);
    expect(imports, "what the browser loads for this file").toEqual(["@tanstack/react-start"]);
    expect(code, "the browser gets no server function").not.toMatch(/\.server\(\s*(async|\()/);

    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return files(path);
        return /\.tsx?$/.test(name) && !name.includes(".test.") ? [path] : [];
      });
    const behind = files(join(root, "src")).filter((path) =>
      /middleware:\s*\[viewerMiddleware\]|\.middleware\(\[viewerMiddleware\]\)/.test(readFileSync(path, "utf8")),
    );
    expect(behind.length).toBeGreaterThan(20);
    expect(behind.map((path) => relative(root, path))).toContain("src/routes/api/chat/index.ts");
  });
});
